import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFile } from 'music-metadata';
import { all, get, run, tx } from './db.ts';
import { config } from './config.ts';
import { settings } from './settings.ts';
import { norm, splitGenres } from './text.ts';
import { addMessage } from './messages.ts';
import { logger } from './log.ts';
import { PLAYLIST_EXTENSIONS, readPlaylistFile, resolveEntry, isUrl } from './playlistfiles.ts';
import { findArtworkFile } from './media.ts';

const log = logger('scanner');

const NATIVE_EXTENSIONS = new Set(['.mp3', '.m4a', '.m4b']);
const EXTRA_EXTENSIONS = new Set(['.flac', '.wma', '.aif', '.aiff', '.ogg', '.oga', '.opus', '.wav']);
const IGNORED_DIR_MARKERS = ['#snapshots', '#recycle', '@__thumb', '@recently-snapshot', '@eadir', '.@__thumb', '$recycle.bin'];
// ID3 frames that some Echo firmwares choke on.
const PROBLEM_ID3_FRAMES = new Set(['TSO2', 'TCMP', 'XRVA', 'TSOC']);

export type Transcode = 'none' | 'recode' | 'repackage';

export function trackIdFor(file: string) {
  return crypto.createHash('sha256').update(file).digest('hex').slice(0, 20);
}

export function isAudioFile(file: string) {
  const ext = path.extname(file).toLowerCase();
  return NATIVE_EXTENSIONS.has(ext) || (settings().extraFormats && EXTRA_EXTENSIONS.has(ext));
}

function checksumOf(st: fs.Stats) {
  return `${Math.floor(st.mtimeMs)}:${st.size}`;
}

export function transcodeFor(file: string, codec: string): Transcode {
  const ext = path.extname(file).toLowerCase();
  if (EXTRA_EXTENSIONS.has(ext) || ext === '.m4a') return 'recode';
  if (/deferredmoov|mp42isom|mp3invalidtags|alac/i.test(codec)) return 'recode';
  if (codec.includes('mp3tagatend')) return 'repackage';
  return 'none';
}

function shouldIgnoreDir(dir: string): boolean {
  const lower = dir.toLowerCase();
  if (IGNORED_DIR_MARKERS.some((m) => lower.includes(m))) return true;
  for (const marker of settings().scanIgnoreFiles.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (fs.existsSync(path.join(dir, marker))) return true;
  }
  return false;
}

async function detectQuirks(file: string, nativeTags: Record<string, { id: string }[]>): Promise<string[]> {
  const quirks: string[] = [];
  const ext = path.extname(file).toLowerCase();
  const fh = await fsp.open(file, 'r');
  try {
    if (ext === '.mp3') {
      const { size } = await fh.stat();
      if (size > 128) {
        const tail = Buffer.alloc(3);
        await fh.read(tail, 0, 3, size - 128);
        if (tail.toString('latin1') === 'TAG') quirks.push('mp3tagatend');
      }
      for (const [format, list] of Object.entries(nativeTags)) {
        if (format.startsWith('ID3v2') && list.some((t) => PROBLEM_ID3_FRAMES.has(t.id))) {
          quirks.push('mp3invalidtags');
          break;
        }
      }
    }
    if (ext === '.m4a' || ext === '.m4b' || ext === '.mp4') {
      const head = Buffer.alloc(1024);
      await fh.read(head, 0, 1024, 0);
      const s = head.toString('latin1');
      if (!s.includes('moov')) quirks.push('deferredmoov');
      if (s.includes('mp42isom')) quirks.push('mp42isom');
    }
  } finally {
    await fh.close();
  }
  return quirks;
}

export type ParsedTrack = {
  title: string; artist: string; albumArtist: string; album: string; genres: string[];
  composer: string; year: number; disc: number; trackNo: number; trackTotal: number;
  codec: string; duration: number; hasArt: boolean;
};

export async function readTags(file: string): Promise<ParsedTrack> {
  const md = await parseFile(file, { duration: true, skipCovers: false });
  const c = md.common;
  const quirks = await detectQuirks(file, md.native as any);
  const codecParts = [md.format.codec, md.format.container].filter(Boolean) as string[];
  const codec = [...new Set(codecParts.map((p) => p.toLowerCase()))].concat(quirks).join(', ');
  const albumArtist = c.albumartist ?? '';
  // Prefer the raw tag: music-metadata splits "AC/DC" into ["AC", "DC"] in `artists`.
  let artist = c.artist ?? (c.artists ?? []).join(', ');
  if (!artist) artist = albumArtist;
  let title = c.title ?? '';
  if (!title) title = path.basename(file, path.extname(file));
  const hasEmbedded = !!c.picture?.some((p) => p.data && p.data.length > 2048);
  return {
    title,
    artist,
    albumArtist,
    album: c.album ?? '',
    genres: splitGenres((c.genre ?? []).join(';')),
    composer: (c.composer ?? []).join(', '),
    year: c.year ?? 0,
    disc: c.disk?.no ?? 0,
    trackNo: c.track?.no ?? 0,
    trackTotal: c.track?.of ?? 0,
    codec,
    duration: Math.round(md.format.duration ?? 0),
    hasArt: hasEmbedded || !!findArtworkFile(file),
  };
}

function isAudiobook(file: string, genres: string[]) {
  if (path.extname(file).toLowerCase() === '.m4b') return true;
  const ab = settings().audiobookGenres.map((g) => g.toLowerCase());
  return genres.some((g) => ab.includes(g.toLowerCase()));
}

function artKeyFor(file: string, album: string, albumArtist: string) {
  // One cover per album folder; tracks without album share by folder.
  return crypto.createHash('sha1').update(`${path.dirname(file)}|${album}|${albumArtist}`).digest('hex').slice(0, 16);
}

function upsertTrack(folderId: string, file: string, checksum: string, t: ParsedTrack) {
  const id = trackIdFor(file);
  const existing = get<{ hidden: number; play_count: number; audiobook: number; last_played: number }>(
    'SELECT hidden, play_count, audiobook, last_played FROM tracks WHERE id = ?', id);
  const audiobook = existing?.audiobook || isAudiobook(file, t.genres) ? 1 : 0;
  tx(() => {
    run(`INSERT OR REPLACE INTO tracks
      (id, folder_id, path, checksum, title, artist, album_artist, album, genre, composer, year, disc, track_no, track_total,
       codec, duration, transcode, has_art, art_key, hidden, audiobook, play_count, last_played, indexed_at,
       title_n, artist_n, album_artist_n, album_n)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, folderId, file, checksum, t.title, t.artist, t.albumArtist, t.album, t.genres.join('; '), t.composer,
      t.year, t.disc, t.trackNo, t.trackTotal, t.codec, t.duration, transcodeFor(file, t.codec), t.hasArt ? 1 : 0,
      artKeyFor(file, t.album, t.albumArtist), existing?.hidden ?? 0, audiobook, existing?.play_count ?? 0,
      existing?.last_played ?? 0, Date.now(), norm(t.title), norm(t.artist), norm(t.albumArtist), norm(t.album));
    run('DELETE FROM track_genres WHERE track_id = ?', id);
    for (const g of t.genres) run('INSERT OR IGNORE INTO track_genres (track_id, genre, genre_n) VALUES (?, ?, ?)', id, g, norm(g));
  });
  return id;
}

type Folder = { id: string; path: string; label: string; status: string };

let scanning = new Set<string>();
const scanQueue: string[] = [];
let scanLoopRunning = false;

export function isScanning() {
  return scanning.size > 0 || scanQueue.length > 0;
}

/** Queue a folder scan (deduplicated). */
export function requestScan(folderId: string) {
  if (!scanQueue.includes(folderId) && !scanning.has(folderId)) scanQueue.push(folderId);
  if (!scanLoopRunning) void scanLoop();
}

export function requestScanAll() {
  for (const f of all<Folder>('SELECT id FROM folders')) requestScan(f.id);
}

async function scanLoop() {
  scanLoopRunning = true;
  try {
    while (scanQueue.length) {
      const id = scanQueue.shift()!;
      const folder = get<Folder>('SELECT * FROM folders WHERE id = ?', id);
      if (!folder) continue;
      scanning.add(id);
      try {
        await scanFolder(folder);
      } catch (err) {
        log.error(`Scan failed for ${folder.path}`, err);
        run("UPDATE folders SET status = 'error', error_message = ? WHERE id = ?", String((err as Error).message ?? err), id);
        addMessage('library', 'error', `No se pudo escanear ${folder.path}`, String((err as Error).message ?? err));
      } finally {
        scanning.delete(id);
      }
    }
  } finally {
    scanLoopRunning = false;
  }
}

async function walk(dir: string, audio: string[], playlists: string[]) {
  if (shouldIgnoreDir(dir)) return;
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    log.warn(`Cannot read ${dir}`, (err as Error).message);
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue; // hidden files/dirs
    const full = path.join(dir, e.name);
    if (e.isDirectory()) await walk(full, audio, playlists);
    else if (e.isFile()) {
      const ext = path.extname(e.name).toLowerCase();
      if (PLAYLIST_EXTENSIONS.has(ext)) playlists.push(full);
      else if (isAudioFile(full)) audio.push(full);
    }
  }
}

export function folderLogPath(folderId: string) {
  return path.join(config.logDir, `import-${folderId}.log`);
}

export async function scanFolder(folder: Folder, onlyPaths?: string[]) {
  const started = Date.now();
  log.info(`Scanning ${folder.path}`);
  run("UPDATE folders SET status = 'scanning', progress = 0, error_message = '' WHERE id = ?", folder.id);
  const logStream = fs.createWriteStream(folderLogPath(folder.id), { flags: 'w' });
  const writeLog = (line: string) => logStream.write(`${new Date().toISOString()} ${line}\n`);

  if (!fs.existsSync(folder.path)) {
    run("UPDATE folders SET status = 'error', error_message = ? WHERE id = ?", 'La carpeta no existe o no está montada', folder.id);
    addMessage('library', 'error', `La carpeta ${folder.path} no está disponible`,
      'Comprueba que el volumen está montado en el contenedor (sección volumes del docker-compose).');
    logStream.end();
    return;
  }

  const audio: string[] = [];
  const playlistFiles: string[] = [];
  if (onlyPaths) audio.push(...onlyPaths);
  else await walk(folder.path, audio, playlistFiles);
  run('UPDATE folders SET identified = ? WHERE id = ?', audio.length, folder.id);
  writeLog(`Identified ${audio.length} audio files and ${playlistFiles.length} playlists`);

  const known = new Map<string, string>();
  for (const r of all<{ path: string; checksum: string }>('SELECT path, checksum FROM tracks WHERE folder_id = ?', folder.id)) {
    known.set(r.path, r.checksum);
  }

  const result = { added: [] as string[], updated: [] as string[], failed: [] as string[] };
  let done = 0;
  let lastProgress = 0;
  const work = audio.slice();
  const worker = async () => {
    for (let file = work.shift(); file; file = work.shift()) {
      try {
        const st = await fsp.stat(file);
        const sum = checksumOf(st);
        const prev = known.get(file);
        if (prev !== sum || onlyPaths) {
          const tags = await readTags(file);
          upsertTrack(folder.id, file, sum, tags);
          (prev ? result.updated : result.added).push(file);
          writeLog(`${prev ? 'UPDATED' : 'ADDED'} ${file} [${tags.codec}]`);
        }
      } catch (err) {
        result.failed.push(file);
        writeLog(`FAILED ${file}: ${(err as Error).message}`);
      }
      done++;
      const pct = Math.floor((done / Math.max(1, audio.length)) * 100);
      if (pct !== lastProgress) {
        lastProgress = pct;
        run('UPDATE folders SET progress = ? WHERE id = ?', pct, folder.id);
      }
    }
  };
  await Promise.all(Array.from({ length: 4 }, worker));

  // Remove tracks that disappeared (only on full scans).
  let removed = 0;
  if (!onlyPaths) {
    const present = new Set(audio);
    for (const p of known.keys()) {
      if (!present.has(p)) {
        run('DELETE FROM tracks WHERE path = ?', p);
        writeLog(`REMOVED ${p}`);
        removed++;
      }
    }
  }

  let playlistCount = 0;
  if (!onlyPaths && settings().autoImportPlaylists) {
    playlistCount = await importPlaylistFiles(folder.id, playlistFiles, writeLog);
  }

  const count = get<{ n: number }>('SELECT COUNT(*) AS n FROM tracks WHERE folder_id = ?', folder.id)!.n;
  run(`UPDATE folders SET status = 'ok', progress = 100, track_count = ?, playlist_count = ?, error_count = ?, last_scan = ?
       WHERE id = ?`, count, playlistCount, result.failed.length, Date.now(), folder.id);
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  writeLog(`Done in ${secs}s: +${result.added.length} ~${result.updated.length} -${removed} !${result.failed.length}`);
  logStream.end();
  log.info(`Scanned ${folder.path} in ${secs}s (+${result.added.length} ~${result.updated.length} -${removed} !${result.failed.length})`);

  if (result.added.length || result.updated.length || removed || result.failed.length) {
    const name = folder.label || folder.path;
    const parts = [
      result.added.length && `${result.added.length} nuevas`,
      result.updated.length && `${result.updated.length} actualizadas`,
      removed && `${removed} eliminadas`,
      result.failed.length && `${result.failed.length} con errores`,
    ].filter(Boolean);
    const examples = result.failed.slice(0, 5).map((f) => `• ${f}`).join('\n');
    addMessage('library', result.failed.length ? 'warning' : 'info', `${name}: ${parts.join(', ')}`,
      result.failed.length ? `Algunos archivos no se pudieron leer:\n${examples}` : '');
  }
}

async function importPlaylistFiles(folderId: string, files: string[], writeLog: (l: string) => void) {
  const byPath = new Map<string, string>();
  const bySuffix = new Map<string, string>();
  for (const r of all<{ id: string; path: string }>('SELECT id, path FROM tracks')) {
    byPath.set(r.path.replace(/\\/g, '/').toLowerCase(), r.id);
    const segs = r.path.replace(/\\/g, '/').toLowerCase().split('/');
    bySuffix.set(segs.slice(-3).join('/'), r.id);
  }
  const seen = new Set<string>();
  for (const file of files) {
    try {
      const entries = await readPlaylistFile(file);
      const ids: string[] = [];
      let streamUrl = '';
      for (const entry of entries) {
        if (isUrl(entry)) {
          if (!streamUrl) streamUrl = entry;
          continue;
        }
        const resolved = resolveEntry(file, entry).toLowerCase();
        const id = byPath.get(resolved) ?? bySuffix.get(resolved.split('/').slice(-3).join('/'));
        if (id) ids.push(id);
      }
      const name = path.basename(file, path.extname(file));
      const existing = get<{ id: string }>('SELECT id FROM playlists WHERE source_path = ?', file);
      const id = existing?.id ?? crypto.randomUUID();
      seen.add(id);
      tx(() => {
        if (existing) run('UPDATE playlists SET name = ?, stream_url = ?, kind = ? WHERE id = ?', name, ids.length ? '' : streamUrl, ids.length || !streamUrl ? 'file' : 'webstream', id);
        else run('INSERT INTO playlists (id, name, kind, source_path, stream_url, folder_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          id, name, ids.length || !streamUrl ? 'file' : 'webstream', file, ids.length ? '' : streamUrl, folderId, Date.now());
        run('DELETE FROM playlist_tracks WHERE playlist_id = ?', id);
        ids.forEach((tid, i) => run('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)', id, i, tid));
      });
      writeLog(`PLAYLIST ${file}: ${ids.length}/${entries.length} tracks matched`);
    } catch (err) {
      writeLog(`PLAYLIST FAILED ${file}: ${(err as Error).message}`);
    }
  }
  // Drop imported playlists whose file is gone.
  for (const p of all<{ id: string }>("SELECT id FROM playlists WHERE kind IN ('file','webstream') AND folder_id = ?", folderId)) {
    if (!seen.has(p.id)) run('DELETE FROM playlists WHERE id = ?', p.id);
  }
  return seen.size;
}

/** Rescan specific tracks (forces metadata re-read). */
export async function rescanTracks(ids: string[]) {
  const rows = all<{ id: string; path: string; folder_id: string }>(
    `SELECT id, path, folder_id FROM tracks WHERE id IN (${ids.map(() => '?').join(',')})`, ...ids);
  for (const r of rows) {
    try {
      const st = await fsp.stat(r.path);
      upsertTrack(r.folder_id, r.path, checksumOf(st), await readTags(r.path));
    } catch (err) {
      log.warn(`Rescan failed ${r.path}`, (err as Error).message);
    }
  }
}

let timer: NodeJS.Timeout | undefined;
export function schedulePeriodicRescan() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => {
    const hours = settings().rescanHours;
    if (!hours) return;
    const due = Date.now() - hours * 3600_000;
    for (const f of all<{ id: string }>('SELECT id FROM folders WHERE last_scan < ?', due)) requestScan(f.id);
  }, 10 * 60_000);
}

/** Lightweight change watcher: fs.watch where supported (local volumes); periodic rescan covers the rest. */
const watchers = new Map<string, fs.FSWatcher>();
const pending = new Map<string, NodeJS.Timeout>();
export function watchFolders() {
  for (const w of watchers.values()) w.close();
  watchers.clear();
  for (const f of all<Folder>('SELECT * FROM folders')) {
    try {
      const w = fs.watch(f.path, { recursive: true }, () => {
        clearTimeout(pending.get(f.id));
        pending.set(f.id, setTimeout(() => requestScan(f.id), 30_000));
      });
      w.on('error', () => w.close());
      watchers.set(f.id, w);
    } catch {
      log.debug(`fs.watch not available for ${f.path}; relying on periodic rescan`);
    }
  }
}
