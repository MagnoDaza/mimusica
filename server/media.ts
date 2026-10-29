import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseFile } from 'music-metadata';
import { config } from './config.ts';
import { settings } from './settings.ts';
import { logger } from './log.ts';

const log = logger('media');

const ART_DIR = path.join(config.cacheDir, 'art');
const TRANSCODE_DIR = path.join(config.cacheDir, 'transcode');
fs.mkdirSync(ART_DIR, { recursive: true });
fs.mkdirSync(TRANSCODE_DIR, { recursive: true });

const TRANSCODE_CACHE_BYTES = Number(process.env.TRANSCODE_CACHE_MB ?? 4096) * 1024 * 1024;

// ---------------------------------------------------------------- ffmpeg

let ffmpegOk: boolean | undefined;
export async function ffmpegAvailable(): Promise<boolean> {
  if (ffmpegOk !== undefined) return ffmpegOk;
  ffmpegOk = await new Promise<boolean>((resolve) => {
    const p = spawn(config.ffmpeg, ['-version'], { stdio: 'ignore' });
    p.on('error', () => resolve(false));
    p.on('exit', (code) => resolve(code === 0));
  });
  if (!ffmpegOk) log.warn('ffmpeg not found: transcoding and artwork resizing disabled');
  return ffmpegOk;
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(config.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    p.stderr.on('data', (d) => (err += d));
    p.on('error', reject);
    p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}: ${err.trim().slice(-500)}`))));
  });
}

// ---------------------------------------------------------------- artwork

const ART_NAMES = ['folder', 'cover', 'front', 'albumart', 'albumartsmall', 'album'];
const ART_EXT = ['.jpg', '.jpeg', '.png', '.webp'];

/** Folder artwork next to the track: <track>.jpg, folder.jpg, cover.png … (case-insensitive). */
export function findArtworkFile(trackPath: string): string | undefined {
  const dir = path.dirname(trackPath);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return undefined;
  }
  const lower = new Map(names.map((n) => [n.toLowerCase(), n]));
  const base = path.basename(trackPath, path.extname(trackPath)).toLowerCase();
  for (const stem of [base, ...ART_NAMES]) {
    for (const ext of ART_EXT) {
      const hit = lower.get(stem + ext);
      if (hit) return path.join(dir, hit);
    }
  }
  return undefined;
}

const artInFlight = new Map<string, Promise<string | undefined>>();

/** Returns a cached JPEG of the requested square size, generating it on first use. */
export async function artworkFor(trackPath: string, artKey: string, size: number): Promise<string | undefined> {
  size = [96, 192, 300, 512, 720, 1080].find((s) => s >= size) ?? 1080;
  const out = path.join(ART_DIR, `${artKey}-${size}.jpg`);
  if (fs.existsSync(out)) return out;
  const key = out;
  if (!artInFlight.has(key)) {
    artInFlight.set(key, generateArt(trackPath, artKey, size, out).finally(() => artInFlight.delete(key)));
  }
  return artInFlight.get(key);
}

async function generateArt(trackPath: string, artKey: string, size: number, out: string) {
  const original = path.join(ART_DIR, `${artKey}-orig`);
  if (!fs.existsSync(original)) {
    let data: Uint8Array | undefined;
    try {
      const md = await parseFile(trackPath, { duration: false, skipCovers: false });
      const pic = md.common.picture?.find((p) => p.type?.toLowerCase().includes('front')) ?? md.common.picture?.[0];
      if (pic?.data && pic.data.length > 2048) data = pic.data;
    } catch {}
    if (!data) {
      const file = findArtworkFile(trackPath);
      if (file) data = await fsp.readFile(file);
    }
    if (!data) return undefined;
    await fsp.writeFile(original, data);
  }
  if (!(await ffmpegAvailable())) return original;
  try {
    await runFfmpeg(['-i', original, '-vf', `scale=${size}:${size}:force_original_aspect_ratio=increase,crop=${size}:${size}`,
      '-frames:v', '1', '-q:v', '3', out]);
    return out;
  } catch (err) {
    log.warn(`Artwork resize failed for ${trackPath}`, (err as Error).message);
    return original;
  }
}

export async function clearArtCache() {
  await fsp.rm(ART_DIR, { recursive: true, force: true });
  await fsp.mkdir(ART_DIR, { recursive: true });
}

// ---------------------------------------------------------------- transcoding

type Job = { file: string; done: Promise<void>; finished: boolean; failed?: Error };
const jobs = new Map<string, Job>();

export function transcodeTarget(trackId: string, checksum: string, mode: 'recode' | 'repackage') {
  const s = settings();
  const tag = mode === 'recode' ? `${s.transcodeBitrate}${s.replayGain ? 'rg' : ''}` : 'copy';
  const safe = checksum.replace(/[^a-z0-9]/gi, '');
  return path.join(TRANSCODE_DIR, `${trackId}-${safe}-${tag}.mp3`);
}

/**
 * Starts (or reuses) a transcode. The output is written to `<target>.part` and renamed when complete,
 * so readers can stream the growing file while ffmpeg works (see `transcodeJob`).
 */
export function startTranscode(trackId: string, source: string, checksum: string, mode: 'recode' | 'repackage'): Job {
  const target = transcodeTarget(trackId, checksum, mode);
  const existing = jobs.get(target);
  if (existing) return existing;
  if (fs.existsSync(target)) {
    const now = new Date();
    fs.utimes(target, now, now, () => {});
    const job: Job = { file: target, done: Promise.resolve(), finished: true };
    return job;
  }
  const part = target + '.part';
  const s = settings();
  const args = mode === 'recode'
    ? ['-i', source, '-map', '0:a:0', '-vn', '-c:a', 'libmp3lame', '-b:a', `${s.transcodeBitrate}k`, '-ac', '2',
       ...(s.replayGain ? ['-af', 'volume=replaygain=track'] : []), '-map_metadata', '-1', '-f', 'mp3', part]
    : ['-i', source, '-map', '0:a:0', '-c:a', 'copy', '-map_metadata', '-1', '-write_id3v1', '0', '-f', 'mp3', part];
  const job: Job = { file: part, finished: false, done: Promise.resolve() };
  job.done = runFfmpeg(args)
    .then(async () => {
      await fsp.rename(part, target);
      job.file = target;
      job.finished = true;
      void pruneTranscodeCache();
    })
    .catch(async (err) => {
      job.failed = err;
      job.finished = true;
      await fsp.rm(part, { force: true });
      log.error(`Transcode failed: ${source}`, err.message);
      throw err;
    })
    .finally(() => setTimeout(() => jobs.delete(target), 1000));
  job.done.catch(() => {});
  jobs.set(target, job);
  log.info(`Transcoding (${mode}) ${source}`);
  return job;
}

/** Look up an in-flight job for a target path. */
export function transcodeJob(target: string): Job | undefined {
  return jobs.get(target);
}

async function pruneTranscodeCache() {
  try {
    const files = await Promise.all(
      (await fsp.readdir(TRANSCODE_DIR))
        .filter((f) => f.endsWith('.mp3'))
        .map(async (f) => {
          const full = path.join(TRANSCODE_DIR, f);
          const st = await fsp.stat(full);
          return { full, size: st.size, used: Math.max(st.atimeMs, st.mtimeMs) };
        }),
    );
    let total = files.reduce((n, f) => n + f.size, 0);
    files.sort((a, b) => a.used - b.used);
    for (const f of files) {
      if (total <= TRANSCODE_CACHE_BYTES) break;
      await fsp.rm(f.full, { force: true });
      total -= f.size;
    }
  } catch (err) {
    log.warn('Transcode cache prune failed', (err as Error).message);
  }
}

export async function clearTranscodeCache() {
  await fsp.rm(TRANSCODE_DIR, { recursive: true, force: true });
  await fsp.mkdir(TRANSCODE_DIR, { recursive: true });
}

// ---------------------------------------------------------------- mime

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.m4b': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.wav': 'audio/wav',
  '.wma': 'audio/x-ms-wma',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
};
export function mimeFor(file: string) {
  return MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream';
}
