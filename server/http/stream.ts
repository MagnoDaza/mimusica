import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { get } from '../db.ts';
import { verifySigned } from '../settings.ts';
import { artworkFor, mimeFor, startTranscode, ffmpegAvailable } from '../media.ts';
import { getQueue } from '../queue.ts';
import { isAuthed } from './auth.ts';
import { logger } from '../log.ts';

const log = logger('stream');

type Track = { id: string; path: string; checksum: string; transcode: 'none' | 'recode' | 'repackage'; art_key: string; has_art: number };

function allowed(req: FastifyRequest, value: string, session: boolean) {
  const k = (req.query as any)?.k as string | undefined;
  return verifySigned(value, k) || (session && isAuthed(req));
}

function parseRange(header: string | undefined, size: number | undefined): { start: number; end?: number } | undefined {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return undefined;
  if (m[1] === '' && m[2] !== '' && size !== undefined) {
    const n = Number(m[2]);
    return { start: Math.max(0, size - n), end: size - 1 };
  }
  return { start: Number(m[1] || 0), end: m[2] === '' ? undefined : Number(m[2]) };
}

/** Answer a HEAD with the real Content-Length (Fastify would rewrite it to 0 for an empty body). */
function headOnly(reply: FastifyReply) {
  reply.hijack();
  reply.raw.writeHead(reply.statusCode, reply.getHeaders() as any);
  reply.raw.end();
}

/** Serve a complete file with HTTP range support. */
async function sendFile(req: FastifyRequest, reply: FastifyReply, file: string, type: string) {
  const st = await fsp.stat(file);
  const size = st.size;
  const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
  reply.header('Accept-Ranges', 'bytes');
  reply.header('Content-Type', type);
  reply.header('ETag', etag);
  reply.header('Cache-Control', 'private, max-age=3600');
  let range = parseRange(req.headers.range, size);
  const ifRange = req.headers['if-range'];
  if (range && ifRange && ifRange !== etag) range = undefined;
  if (range) {
    const end = Math.min(range.end ?? size - 1, size - 1);
    if (range.start >= size || range.start > end) {
      reply.code(416).header('Content-Range', `bytes */${size}`);
      return reply.send();
    }
    reply.code(206).header('Content-Range', `bytes ${range.start}-${end}/${size}`).header('Content-Length', end - range.start + 1);
    if (req.method === 'HEAD') return headOnly(reply);
    return reply.send(fs.createReadStream(file, { start: range.start, end }));
  }
  reply.header('Content-Length', size);
  if (req.method === 'HEAD') return headOnly(reply);
  return reply.send(fs.createReadStream(file));
}

/** Stream a file that ffmpeg is still writing; follows it until the job finishes. */
async function sendGrowing(req: FastifyRequest, reply: FastifyReply, job: ReturnType<typeof startTranscode>) {
  const range = parseRange(req.headers.range, undefined);
  const start = range?.start ?? 0;
  reply.raw.setHeader('Content-Type', 'audio/mpeg');
  reply.raw.setHeader('Accept-Ranges', 'bytes');
  reply.raw.setHeader('Cache-Control', 'no-store');
  if (start > 0) {
    reply.raw.statusCode = 206;
    reply.raw.setHeader('Content-Range', `bytes ${start}-*/*`);
  }
  reply.hijack();
  if (req.method === 'HEAD') return reply.raw.end();

  let fh: fsp.FileHandle | undefined;
  let aborted = false;
  // The response's 'close' fires when the Echo hangs up; also unblocks a pending 'drain' wait.
  const closed = new Promise<void>((r) => reply.raw.once('close', () => { aborted = true; r(); }));
  try {
    for (let i = 0; i < 100 && !fh; i++) {
      try {
        fh = await fsp.open(job.file, 'r');
      } catch {
        if (job.finished && job.failed) throw job.failed;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    if (!fh) throw new Error('transcode output never appeared');
    const buf = Buffer.alloc(64 * 1024);
    let pos = start;
    while (!aborted) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
      if (bytesRead > 0) {
        pos += bytesRead;
        if (!reply.raw.write(buf.subarray(0, bytesRead))) await Promise.race([new Promise((r) => reply.raw.once('drain', r)), closed]);
        continue;
      }
      if (job.finished) {
        // One last read in case ffmpeg flushed between our read and the flag.
        const tail = await fh.read(buf, 0, buf.length, pos);
        if (tail.bytesRead > 0) {
          pos += tail.bytesRead;
          reply.raw.write(buf.subarray(0, tail.bytesRead));
          continue;
        }
        break;
      }
      await new Promise((r) => setTimeout(r, 150));
    }
  } catch (err) {
    log.error('Progressive stream failed', err);
  } finally {
    await fh?.close();
    reply.raw.end();
  }
}

/**
 * @param opts.session also accept the console session cookie (console port only — the public port
 *                     must only honour signed URLs, since without a password every session is valid).
 */
export function registerStreamRoutes(app: FastifyInstance, opts: { session: boolean }) {
  const isAllowed = (req: FastifyRequest, value: string) => allowed(req, value, opts.session);
  const streamHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const id = (req.params as any).id.replace(/\.\w+$/, '');
    if (!isAllowed(req, id)) return reply.code(403).send();
    const track = get<Track>('SELECT id, path, checksum, transcode, art_key, has_art FROM tracks WHERE id = ?', id);
    if (!track) return reply.code(404).send();
    if (!fs.existsSync(track.path)) {
      log.warn(`Missing file ${track.path}`);
      return reply.code(404).send();
    }
    log.debug(`${req.method} ${track.path} range=${req.headers.range ?? '-'} ua=${req.headers['user-agent'] ?? ''}`);
    if (track.transcode === 'none' || !(await ffmpegAvailable())) return sendFile(req, reply, track.path, mimeFor(track.path));
    const job = startTranscode(track.id, track.path, track.checksum, track.transcode);
    if (job.finished && !job.failed) return sendFile(req, reply, job.file, 'audio/mpeg');
    // Short tracks: wait a moment so we can answer with Content-Length (better seeking on Echo).
    await Promise.race([job.done.catch(() => {}), new Promise((r) => setTimeout(r, 2500))]);
    if (job.finished) {
      if (job.failed) return reply.code(500).send();
      return sendFile(req, reply, job.file, 'audio/mpeg');
    }
    return sendGrowing(req, reply, job);
  };
  app.get('/stream/:id', streamHandler); // Fastify adds the matching HEAD route

  app.get('/art/:id', async (req, reply) => {
    const id = (req.params as any).id;
    if (!isAllowed(req, id)) return reply.code(403).send();
    const track = get<Track>('SELECT id, path, art_key, has_art FROM tracks WHERE id = ?', id);
    if (!track || !track.has_art) return reply.code(404).send();
    const size = Number((req.query as any).s ?? 300);
    const file = await artworkFor(track.path, track.art_key, size);
    if (!file) return reply.code(404).send();
    reply.header('Cache-Control', 'public, max-age=604800, immutable');
    const head = Buffer.alloc(4);
    const fh = await fsp.open(file, 'r');
    await fh.read(head, 0, 4, 0);
    await fh.close();
    const type = head[0] === 0x89 ? 'image/png' : head.toString('latin1', 0, 4) === 'RIFF' ? 'image/webp' : 'image/jpeg';
    return reply.type(type).send(fs.createReadStream(file));
  });

  // Web radio: Alexa only plays HTTPS, so plain-HTTP streams are relayed through here.
  app.get('/radio/:qid', async (req, reply) => {
    const qid = (req.params as any).qid;
    if (!isAllowed(req, qid)) return reply.code(403).send();
    const q = getQueue(qid);
    if (!q?.stream_url) return reply.code(404).send();
    let url = q.stream_url;
    try {
      if (/\.(pls|m3u8?)(\?|$)/i.test(url) && !/\.m3u8/i.test(url)) {
        const text = await (await fetch(url)).text();
        const first = text.match(/^File\d+=(.+)$/im)?.[1] ?? text.split(/\r?\n/).find((l) => /^https?:\/\//i.test(l.trim()));
        if (first) url = first.trim();
      }
      if (url.startsWith('https://')) return reply.redirect(url, 302);
      const ac = new AbortController();
      req.raw.on('close', () => ac.abort());
      const upstream = await fetch(url, { signal: ac.signal, headers: { 'Icy-MetaData': '0', 'User-Agent': 'MiMusica/1.0' } });
      if (!upstream.ok || !upstream.body) return reply.code(502).send();
      reply.header('Content-Type', upstream.headers.get('content-type') ?? 'audio/mpeg');
      reply.header('Cache-Control', 'no-store');
      return reply.send(upstream.body as any);
    } catch (err) {
      if ((err as Error).name !== 'AbortError') log.warn(`Radio relay failed for ${url}`, (err as Error).message);
      return reply.code(502).send();
    }
  });
}
