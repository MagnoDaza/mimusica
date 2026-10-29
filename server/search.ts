/**
 * Voice request → play queue. Resolution cascade:
 *   learnings → [joined words] → exact words → fuzzy words → [term-as-artist]
 * then selects every track that matches the resolved values exactly.
 */
import { all, get, run } from './db.ts';
import { settings } from './settings.ts';
import { norm, tokens, similarity, wordCount, sha256 } from './text.ts';
import { createQueue, getBookmark, findPosForTrack, type Queue } from './queue.ts';
import { logger } from './log.ts';
import fs from 'node:fs';

const log = logger('search');

export type Criteria = {
  album?: string; artist?: string; genre?: string; song?: string; book?: string;
  playlist?: string; query?: string;
  bookChapter?: number; shuffle?: boolean;
};

export type PlayPlan = {
  queue: Queue;
  /** Position + offset to start from (bookmarks / chapters). */
  startPos?: number;
  startOffsetMs?: number;
  trackCount: number;
};

type Field = 'album' | 'artist' | 'genre' | 'song' | 'book';
const FIELDS: Field[] = ['album', 'artist', 'genre', 'song', 'book'];

// ---------------------------------------------------------------- in-memory candidate index

type Cand = {
  id: string; hidden: boolean; audiobook: boolean; folder: string;
  title: string; artist: string; albumArtist: string; album: string; genres: string[];
  n: { song: string; artist: string; albumArtist: string; album: string; genres: string[] };
  t: { song: Set<string>; artist: Set<string>; albumArtist: Set<string>; album: Set<string>; genres: Set<string>[] };
};

let cache: { at: string; rows: Cand[] } | undefined;

/** Cheap signature of the tracks table; any scan, hide or audiobook change alters it. */
function librarySignature() {
  const s = get<any>(`SELECT COUNT(*) AS n, MAX(indexed_at) AS m, SUM(hidden) AS h, SUM(audiobook) AS a,
                      (SELECT COUNT(*) FROM track_genres) AS g FROM tracks`)!;
  return `${s.n}:${s.m}:${s.h}:${s.a}:${s.g}`;
}

function tokenSet(n: string) {
  const s = new Set(tokens(n));
  if (n.includes(' ')) s.add(n.replace(/ /g, '')); // lets "acdc" match "AC/DC" → "ac dc"
  return s;
}

function candidates(): Cand[] {
  const sig = librarySignature();
  if (cache && cache.at === sig) return cache.rows;
  const genres = new Map<string, string[]>();
  for (const g of all<{ track_id: string; genre: string }>('SELECT track_id, genre FROM track_genres')) {
    const list = genres.get(g.track_id) ?? [];
    list.push(g.genre);
    genres.set(g.track_id, list);
  }
  const rows = all<any>('SELECT id, folder_id, hidden, audiobook, title, artist, album_artist, album, title_n, artist_n, album_artist_n, album_n FROM tracks')
    .map((r): Cand => {
      const gs = genres.get(r.id) ?? [];
      const gn = gs.map(norm);
      return {
        id: r.id, hidden: !!r.hidden, audiobook: !!r.audiobook, folder: r.folder_id,
        title: r.title, artist: r.artist, albumArtist: r.album_artist, album: r.album, genres: gs,
        n: { song: r.title_n, artist: r.artist_n, albumArtist: r.album_artist_n, album: r.album_n, genres: gn },
        t: { song: tokenSet(r.title_n), artist: tokenSet(r.artist_n), albumArtist: tokenSet(r.album_artist_n), album: tokenSet(r.album_n), genres: gn.map(tokenSet) },
      };
    });
  cache = { at: sig, rows };
  return rows;
}

// ---------------------------------------------------------------- scoring

type Mode = 'exact' | 'fuzzy';

/** Score how well query tokens match a field. 0 = no match. Favors fields not much longer than the query. */
function scoreField(qTokens: string[], fieldTokens: Set<string>, mode: Mode): number {
  if (!qTokens.length || !fieldTokens.size) return 0;
  let total = 0;
  let matched = 0;
  for (const q of qTokens) {
    if (fieldTokens.has(q)) {
      total += 1;
      matched++;
      continue;
    }
    if (mode === 'fuzzy') {
      let best = 0;
      for (const f of fieldTokens) {
        if (Math.abs(f.length - q.length) > Math.ceil(q.length / 2)) continue;
        const s = similarity(q, f);
        if (s > best) best = s;
      }
      // Accept up to ~half the letters wrong; stricter for very short words.
      const threshold = q.length <= 3 ? 0.66 : 0.5;
      if (best >= threshold) {
        total += best * 0.9;
        matched++;
      }
    }
  }
  if (!matched) return 0;
  const coverage = total / qTokens.length;
  const lengthNorm = Math.sqrt(Math.min(1, qTokens.length / fieldTokens.size));
  return coverage * (0.6 + 0.4 * lengthNorm);
}

type Resolved = Partial<Record<Field, string>> & { artistIsAlbumArtist?: boolean };

/** One pass over the library with all requested fields as MUST clauses. */
function bestMatch(q: Partial<Record<Field, string>>, mode: Mode, wantAudiobook: boolean): { resolved: Resolved; score: number } | undefined {
  const qt: Partial<Record<Field, string[]>> = {};
  for (const f of FIELDS) if (q[f]) qt[f] = tokens(norm(q[f]));
  type Hit = { score: number; resolved: Resolved; exact: boolean };
  const hits = new Map<string, Hit>();
  for (const c of candidates()) {
    if (c.hidden || c.audiobook !== wantAudiobook) continue;
    let score = 1;
    const resolved: Resolved = {};
    let exact = true;
    if (qt.album) {
      const s = scoreField(qt.album, c.t.album, mode);
      if (!s) continue;
      score *= s; resolved.album = c.album; exact &&= c.n.album === norm(q.album);
    }
    if (qt.book) {
      const s = scoreField(qt.book, c.t.album, mode);
      if (!s) continue;
      score *= s; resolved.book = c.album; exact &&= c.n.album === norm(q.book);
    }
    if (qt.song) {
      const s = scoreField(qt.song, c.t.song, mode);
      if (!s) continue;
      score *= s; resolved.song = c.title; exact &&= c.n.song === norm(q.song);
    }
    if (qt.artist) {
      const a = scoreField(qt.artist, c.t.artist, mode);
      const aa = scoreField(qt.artist, c.t.albumArtist, mode);
      if (!a && !aa) continue;
      score *= Math.max(a, aa);
      resolved.artist = aa > a ? c.albumArtist : c.artist;
      resolved.artistIsAlbumArtist = aa > a;
      exact &&= norm(resolved.artist) === norm(q.artist);
    }
    if (qt.genre) {
      let best = 0, which = -1;
      c.t.genres.forEach((g, i) => {
        const s = scoreField(qt.genre!, g, mode);
        if (s > best) { best = s; which = i; }
      });
      if (!best) continue;
      score *= best; resolved.genre = c.genres[which]; exact &&= c.n.genres[which] === norm(q.genre);
    }
    const key = FIELDS.map((f) => norm(resolved[f] ?? '')).join('|');
    const prev = hits.get(key);
    if (!prev || prev.score < score) hits.set(key, { score, resolved, exact });
  }
  if (!hits.size) return undefined;
  // Top 10 by score; an exact match to what was said wins.
  const top = [...hits.values()].sort((a, b) => b.score - a.score).slice(0, 10);
  const pick = top.find((h) => h.exact) ?? top[0];
  return { resolved: pick.resolved, score: pick.exact ? pick.score + 1 : pick.score };
}

/** The 4-step cascade for one combination of criteria. */
function cascade(q: Partial<Record<Field, string>>, wantAudiobook: boolean): Resolved | undefined {
  const given = FIELDS.filter((f) => q[f]);
  if (!given.length) return undefined;
  const maxWords = Math.max(...given.map((f) => wordCount(q[f])));
  // mode 0: two-word terms are also tried joined ("ac dc" → "acdc")
  if (maxWords === 2) {
    const joined: Partial<Record<Field, string>> = {};
    for (const f of given) joined[f] = q[f]!.replace(/\s+/g, '');
    const hit = bestMatch(joined, 'exact', wantAudiobook);
    if (hit) return hit.resolved;
  }
  const exact = bestMatch(q, 'exact', wantAudiobook);
  if (exact) return exact.resolved;
  const fuzzy = bestMatch(q, 'fuzzy', wantAudiobook);
  if (fuzzy) return fuzzy.resolved;
  // mode 3: a lone genre or lone song is retried as an artist
  if (given.length === 1 && (given[0] === 'genre' || given[0] === 'song')) {
    const asArtist = bestMatch({ artist: q[given[0]] }, 'fuzzy', false);
    if (asArtist) return asArtist.resolved;
  }
  return undefined;
}

// ---------------------------------------------------------------- learnings & history

type Learning = Record<string, string | null> & { id: string };

function applyLearnings(c: Criteria): { c: Criteria; learning?: Learning } {
  const eq = (a?: string | null, b?: string | null) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
  for (const l of all<Learning>('SELECT * FROM learnings ORDER BY created_at DESC')) {
    const keys = ['album', 'artist', 'genre', 'song', 'book', 'playlist', 'query'] as const;
    const anyGiven = keys.some((k) => c[k]);
    if (!anyGiven) continue;
    if (keys.every((k) => eq(c[k], l[`criteria_${k}`]))) {
      const trained: Criteria = { bookChapter: c.bookChapter, shuffle: c.shuffle };
      for (const k of ['album', 'artist', 'genre', 'song', 'book', 'playlist'] as const) {
        const v = l[`trained_${k}`];
        if (v) trained[k] = v;
      }
      log.info(`Learning ${l.id} applied`);
      return { c: trained, learning: l };
    }
  }
  return { c };
}

function recordHistory(entry: {
  criteria: Criteria; found: Record<string, unknown>; trained?: Criteria; learningId?: string;
  success: boolean; trackCount: number; deviceId?: string; utterance?: string;
}) {
  const { bookChapter, shuffle, ...criteria } = entry.criteria;
  run(`INSERT INTO history (ts, device_id, utterance, criteria, found, trained, learning_id, success, track_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    Date.now(), entry.deviceId ?? '', entry.utterance ?? '', JSON.stringify(criteria), JSON.stringify(entry.found),
    JSON.stringify(entry.trained ?? {}), entry.learningId ?? '', entry.success ? 1 : 0, entry.trackCount);
  run('DELETE FROM history WHERE id <= (SELECT id FROM history ORDER BY id DESC LIMIT 1 OFFSET 2000)');
}

// ---------------------------------------------------------------- track selection

const MAX_QUEUE = 1000;
const EVERYTHING_SIZE = 500;

function sample<T>(arr: T[], n: number): T[] {
  if (arr.length <= n) return arr;
  const idx = arr.map((_, i) => i);
  for (let i = idx.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [idx[i], idx[j]] = [idx[j], idx[i]];
  }
  return idx.slice(0, n).sort((a, b) => a - b).map((i) => arr[i]);
}

function shuffled<T>(arr: T[]): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function selectTracks(r: Resolved, audiobook: boolean): string[] {
  const where: string[] = ['t.hidden = 0', `t.audiobook = ${audiobook ? 1 : 0}`];
  const params: any[] = [];
  if (r.song) { where.push('t.title_n = ?'); params.push(norm(r.song)); }
  if (r.album) { where.push('t.album_n = ?'); params.push(norm(r.album)); }
  if (r.book) { where.push('t.album_n = ?'); params.push(norm(r.book)); }
  if (r.artist) { where.push('(t.artist_n = ? OR t.album_artist_n = ?)'); params.push(norm(r.artist), norm(r.artist)); }
  if (r.genre) { where.push('EXISTS (SELECT 1 FROM track_genres g WHERE g.track_id = t.id AND g.genre_n = ?)'); params.push(norm(r.genre)); }
  const order = r.album ? 't.disc, t.track_no, t.path'
    : r.book ? 't.disc, t.track_no, t.title_n, t.path'
    : 't.album_n, t.disc, t.track_no, t.path';
  return all<{ id: string }>(`SELECT t.id FROM tracks t WHERE ${where.join(' AND ')} ORDER BY ${order}`, ...params).map((x) => x.id);
}

function nameFor(r: Resolved): string {
  if (r.book) return r.book;
  if (r.song && r.artist) return `la canción ${r.song} de ${r.artist}`;
  if (r.song) return `la canción ${r.song}`;
  if (r.album && r.artist) return `el álbum ${r.album} de ${r.artist}`;
  if (r.album) return `el álbum ${r.album}`;
  if (r.artist && r.genre) return `${r.genre} de ${r.artist}`;
  if (r.artist) return `música de ${r.artist}`;
  if (r.genre) return `música ${r.genre}`;
  return 'tu música';
}

function searchHash(r: Resolved) {
  return sha256(['song', 'album', 'artist', 'genre', 'book'].map((k) => (r as any)[k]?.toLowerCase() ?? '').join(','));
}

function everything(): PlayPlan {
  const ids = all<{ id: string }>('SELECT id FROM tracks WHERE hidden = 0 AND audiobook = 0 ORDER BY RANDOM() LIMIT ?', EVERYTHING_SIZE).map((x) => x.id);
  const queue = createQueue('toda tu música', ids);
  return { queue, trackCount: ids.length };
}

// ---------------------------------------------------------------- playlists & folder labels

export function findPlaylist(search: string, shuffle: boolean, ctx: { deviceId?: string; utterance?: string } = {}): PlayPlan | undefined {
  const { c, learning } = applyLearnings({ playlist: search });
  const wanted = c.playlist ?? search;
  const options = [
    ...all<{ id: string; name: string; kind: string; stream_url: string }>('SELECT id, name, kind, stream_url FROM playlists'),
    ...all<{ id: string; label: string; path: string }>("SELECT id, label, path FROM folders WHERE label != ''")
      .map((f) => ({ id: f.id, name: f.label, kind: 'folder', stream_url: '' })),
  ];
  const qn = norm(wanted);
  let pick = options.find((o) => norm(o.name) === qn);
  if (!pick) {
    for (const mode of ['exact', 'fuzzy'] as Mode[]) {
      let best = 0;
      for (const o of options) {
        const s = scoreField(tokens(qn), tokenSet(norm(o.name)), mode);
        if (s > best) { best = s; pick = o; }
      }
      if (pick) break;
    }
  }
  const finish = (plan: PlayPlan | undefined, found: string | null) => {
    recordHistory({ criteria: { playlist: search }, found: { playlist: found }, trained: learning ? c : undefined,
      learningId: learning?.id, success: !!plan, trackCount: plan?.trackCount ?? 0, ...ctx });
    return plan;
  };
  if (!pick) return finish(undefined, null);
  run('UPDATE playlists SET last_used = ? WHERE id = ?', Date.now(), pick.id);

  if (pick.kind === 'webstream') {
    const queue = createQueue(pick.name, [], { streamUrl: pick.stream_url });
    return finish({ queue, trackCount: 1 }, pick.name);
  }
  let ids: string[];
  if (pick.kind === 'folder') {
    ids = all<{ id: string }>('SELECT id FROM tracks WHERE folder_id = ? AND hidden = 0 AND audiobook = 0 ORDER BY RANDOM() LIMIT ?', pick.id, EVERYTHING_SIZE).map((x) => x.id);
  } else {
    ids = all<{ track_id: string }>(`SELECT pt.track_id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
                                     WHERE pt.playlist_id = ? AND t.hidden = 0 ORDER BY pt.position`, pick.id).map((x) => x.track_id);
    if (shuffle) ids = shuffled(ids);
  }
  if (!ids.length) return finish(undefined, pick.name);
  const queue = createQueue(pick.kind === 'folder' ? pick.name : `tu lista ${pick.name}`, ids.slice(0, MAX_QUEUE));
  return finish({ queue, trackCount: Math.min(ids.length, MAX_QUEUE) }, pick.name);
}

// ---------------------------------------------------------------- main entry

export function resolve(input: Criteria, ctx: { deviceId?: string; utterance?: string } = {}): PlayPlan | undefined {
  const cleaned: Criteria = { ...input };
  for (const k of ['album', 'artist', 'genre', 'song', 'book', 'playlist', 'query'] as const) {
    const v = cleaned[k]?.replace(/[{}]/g, '').trim();
    cleaned[k] = v || undefined;
  }

  if (cleaned.playlist) return findPlaylist(cleaned.playlist, !!cleaned.shuffle, ctx);

  const { c, learning } = applyLearnings(cleaned);
  if (c.playlist) return findPlaylist(c.playlist, !!c.shuffle, ctx);

  const hasCriteria = !!(c.album || c.artist || c.genre || c.song || c.book || c.query);
  if (!hasCriteria) {
    const def = settings().defaultPlaylist;
    if (def) {
      const plan = findPlaylist(def, settings().defaultPlaylistShuffle, ctx);
      if (plan) return plan;
    }
    const plan = everything();
    recordHistory({ criteria: { ...cleaned }, found: { everything: true }, success: plan.trackCount > 0, trackCount: plan.trackCount, ...ctx });
    return plan.trackCount ? plan : undefined;
  }

  let resolved: Resolved | undefined;
  const wantAudiobook = !!c.book;
  if (c.query) {
    resolved = resolveAnything(c.query);
    if (!resolved) {
      // Maybe it's a playlist or a labelled folder.
      const plan = findPlaylist(c.query, !!c.shuffle, ctx);
      if (plan) return plan;
    }
  } else {
    resolved = cascade({ album: c.album, artist: c.artist, genre: c.genre, song: c.song, book: c.book }, wantAudiobook);
  }

  const done = (plan: PlayPlan | undefined) => {
    recordHistory({
      criteria: cleaned, found: resolved ?? {}, trained: learning ? c : undefined, learningId: learning?.id,
      success: !!plan, trackCount: plan?.trackCount ?? 0, ...ctx,
    });
    return plan;
  };
  if (!resolved) return done(undefined);

  const audiobook = !!resolved.book;
  let ids = selectTracks(resolved, audiobook);
  if (!ids.length) return done(undefined);
  if (ids.length > MAX_QUEUE) ids = sample(ids, MAX_QUEUE);
  // Genre requests always play shuffled; so does an explicit "aleatorio".
  if ((resolved.genre && !resolved.album && !resolved.song) || c.shuffle) ids = shuffled(ids);

  const hash = searchHash(resolved);
  const queue = createQueue(nameFor(resolved), ids, { audiobook, searchHash: audiobook ? hash : '' });
  const plan: PlayPlan = { queue, trackCount: ids.length };

  if (audiobook) {
    if (c.bookChapter && c.bookChapter > 0) {
      plan.startPos = Math.min(c.bookChapter, ids.length) - 1;
      queue.name = `${resolved.book}, capítulo ${c.bookChapter}`;
      run('UPDATE queues SET name = ? WHERE id = ?', queue.name, queue.id);
    } else {
      const bm = getBookmark(hash);
      const track = bm && get<{ path: string }>('SELECT path FROM tracks WHERE id = ?', bm.track_id);
      if (bm && track && fs.existsSync(track.path)) {
        const pos = findPosForTrack(queue.id, bm.track_id);
        if (pos !== undefined) {
          plan.startPos = pos;
          plan.startOffsetMs = Math.max(0, bm.offset_ms - 10_000); // resume 10 s earlier
        }
      }
    }
  }
  log.info(`Resolved ${JSON.stringify(cleaned)} → "${queue.name}" (${ids.length} tracks)`);
  return done(plan);
}

/** A free-form "pon X": try artist, album, song, then genre — exact words first, then fuzzy. */
function resolveAnything(query: string): Resolved | undefined {
  const qn = norm(query);
  // Exact equality wins outright, in priority order.
  for (const field of ['artist', 'album', 'song', 'genre'] as const) {
    const hit = bestMatch({ [field]: query }, 'exact', false);
    if (hit && hit.score > 1) {
      const v = hit.resolved[field];
      if (v && norm(v) === qn) return hit.resolved;
    }
  }
  const joined = wordCount(query) === 2 ? query.replace(/\s+/g, '') : undefined;
  for (const mode of ['exact', 'fuzzy'] as Mode[]) {
    let best: { resolved: Resolved; score: number } | undefined;
    for (const field of ['artist', 'album', 'song', 'genre'] as const) {
      for (const q of joined && mode === 'exact' ? [joined, query] : [query]) {
        const hit = bestMatch({ [field]: q }, mode, false);
        if (hit && (!best || hit.score > best.score + 0.05)) best = hit;
      }
    }
    if (best) return best.resolved;
  }
  // Audiobooks last.
  return cascade({ book: query }, true);
}

/** Dry run used by the console's "probar" box: what would play, without creating a queue. */
export function explain(input: Criteria) {
  const plan = resolve(input, { utterance: '(prueba desde la consola)' });
  if (!plan) return { ok: false as const };
  const tracks = all(`SELECT t.id, t.title, t.artist, t.album FROM queue_items qi JOIN tracks t ON t.id = qi.track_id
                      WHERE qi.queue_id = ? ORDER BY qi.pos LIMIT 25`, plan.queue.id);
  return { ok: true as const, name: plan.queue.name, trackCount: plan.trackCount, startPos: plan.startPos, startOffsetMs: plan.startOffsetMs, tracks, queueId: plan.queue.id };
}
