import crypto from 'node:crypto';
import fs from 'node:fs';
import { all, get, run, tx } from './db.ts';
import { logger } from './log.ts';
import { addMessage } from './messages.ts';

const log = logger('queue');

export type Queue = {
  id: string; name: string; audiobook: number; search_hash: string; stream_url: string;
  created_at: number; last_used: number;
};
export type QueueItem = { queue_id: string; pos: number; rand_order: number; track_id: string };
export type Track = Record<string, any> & { id: string; path: string; title: string; artist: string; album: string; duration: number };

export const LAST_BOOKMARK = 'SPECIAL_LAST';
const MAX_QUEUES = 100;

export function createQueue(name: string, trackIds: string[], opts: { audiobook?: boolean; searchHash?: string; streamUrl?: string } = {}): Queue {
  const id = crypto.randomUUID();
  const now = Date.now();
  tx(() => {
    run('INSERT INTO queues (id, name, audiobook, search_hash, stream_url, created_at, last_used) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, name, opts.audiobook ? 1 : 0, opts.searchHash ?? '', opts.streamUrl ?? '', now, now);
    const stmtArgs: [string, number, number, string][] = trackIds.map((t, i) => [id, i, opts.audiobook ? i : crypto.randomInt(1_000_000), t]);
    for (const a of stmtArgs) run('INSERT INTO queue_items (queue_id, pos, rand_order, track_id) VALUES (?, ?, ?, ?)', ...a);
  });
  pruneQueues();
  return getQueue(id)!;
}

export function getQueue(id: string) {
  return get<Queue>('SELECT * FROM queues WHERE id = ?', id);
}

export function queueLength(id: string) {
  return get<{ n: number }>('SELECT COUNT(*) AS n FROM queue_items WHERE queue_id = ?', id)!.n;
}

function pruneQueues() {
  // Keep recent queues and anything a device or bookmark still points at.
  run(`DELETE FROM queues WHERE id NOT IN (SELECT id FROM queues ORDER BY last_used DESC LIMIT ?)
       AND id NOT IN (SELECT queue_id FROM devices) AND id NOT IN (SELECT queue_id FROM bookmarks)`, MAX_QUEUES);
}

export function touchQueue(id: string) {
  run('UPDATE queues SET last_used = ? WHERE id = ?', Date.now(), id);
}

function ordered(queueId: string, shuffle: boolean, audiobook: boolean): QueueItem[] {
  const order = shuffle && !audiobook ? 'rand_order, pos' : 'pos';
  return all<QueueItem>(`SELECT * FROM queue_items WHERE queue_id = ? ORDER BY ${order}`, queueId);
}

export type Step = 'first' | 'next' | 'previous' | 'current';

/**
 * Navigate a queue. Missing files are skipped (up to 10) and reported, like the original.
 * Returns the item and its track, or undefined at the end of the queue.
 */
export function navigate(queueId: string, fromPos: number | undefined, step: Step, opts: { loop: boolean; shuffle: boolean }):
  { item: QueueItem; track: Track } | undefined {
  const q = getQueue(queueId);
  if (!q) return undefined;
  touchQueue(queueId);
  const list = ordered(queueId, opts.shuffle, !!q.audiobook);
  if (!list.length) return undefined;
  let idx = fromPos === undefined ? 0 : Math.max(0, list.findIndex((i) => i.pos === fromPos));
  let s = step;
  for (let attempt = 0; attempt < 10; attempt++) {
    let target: number | undefined;
    if (s === 'first') target = 0;
    else if (s === 'current') target = idx;
    else if (s === 'next') target = idx < list.length - 1 ? idx + 1 : opts.loop ? 0 : undefined;
    else if (s === 'previous') target = idx > 0 ? idx - 1 : opts.loop ? list.length - 1 : undefined;
    if (target === undefined) return undefined;
    const item = list[target];
    const track = get<Track>('SELECT * FROM tracks WHERE id = ?', item.track_id);
    if (track && !track.hidden && fs.existsSync(track.path)) return { item, track };
    if (track && !fs.existsSync(track.path)) {
      addMessage('streaming', 'warning', `No se encontró ${track.path}`,
        'El archivo no existe. Si está en otro volumen del NAS, comprueba que está montado en el contenedor.');
    }
    log.warn(`Skipping unavailable track at pos ${item.pos}`);
    idx = target;
    if (s === 'first' || s === 'current') s = 'next';
  }
  return undefined;
}

export function itemAt(queueId: string, pos: number) {
  const item = get<QueueItem>('SELECT * FROM queue_items WHERE queue_id = ? AND pos = ?', queueId, pos);
  if (!item) return undefined;
  const track = get<Track>('SELECT * FROM tracks WHERE id = ?', item.track_id);
  return track ? { item, track } : undefined;
}

export function findPosForTrack(queueId: string, trackId: string) {
  return get<{ pos: number }>('SELECT pos FROM queue_items WHERE queue_id = ? AND track_id = ? ORDER BY pos LIMIT 1', queueId, trackId)?.pos;
}

// ---------------------------------------------------------------- bookmarks

export type Bookmark = { search_hash: string; track_id: string; offset_ms: number; queue_id: string; updated_at: number };

export function getBookmark(hash: string) {
  return get<Bookmark>('SELECT * FROM bookmarks WHERE search_hash = ?', hash);
}

export function saveBookmark(hash: string, trackId: string, offsetMs: number, queueId = '') {
  run(`INSERT INTO bookmarks (search_hash, track_id, offset_ms, queue_id, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(search_hash) DO UPDATE SET track_id = excluded.track_id, offset_ms = excluded.offset_ms,
       queue_id = excluded.queue_id, updated_at = excluded.updated_at`, hash, trackId, Math.max(0, Math.floor(offsetMs)), queueId, Date.now());
}

export function clearBookmark(hash: string) {
  run('DELETE FROM bookmarks WHERE search_hash = ?', hash);
}

export function listBookmarks() {
  return all(`SELECT b.*, t.title, t.album, t.artist FROM bookmarks b LEFT JOIN tracks t ON t.id = b.track_id
              WHERE b.search_hash != ? ORDER BY b.updated_at DESC`, LAST_BOOKMARK);
}
