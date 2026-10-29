import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { FastifyInstance } from 'fastify';
import { all, get, run, tx } from '../db.ts';
import { config } from '../config.ts';
import { settings, updateSettings, publicSettings, setPassword, checkPassword, sign } from '../settings.ts';
import { listMessages, clearMessage, clearAllMessages } from '../messages.ts';
import { requestScan, requestScanAll, rescanTracks, folderLogPath, isScanning, watchFolders } from '../scanner.ts';
import { explain, type Criteria } from '../search.ts';
import { createQueue, listBookmarks, clearBookmark } from '../queue.ts';
import { buildInteractionModel } from '../alexa/model.ts';
import { ffmpegAvailable, clearArtCache, clearTranscodeCache } from '../media.ts';
import { m3uExport } from '../playlistfiles.ts';
import { isAuthed, setSessionCookie, clearSessionCookie } from './auth.ts';

const started = Date.now();
const SORTS: Record<string, string> = {
  title: 'title_n', artist: 'artist_n', album: 'album_n, disc, track_no', genre: 'genre', year: 'year',
  playcount: 'play_count', duration: 'duration', added: 'indexed_at', path: 'path', track: 'disc, track_no',
};

function inRoots(p: string) {
  const resolved = path.resolve(p);
  return config.mediaRoots.some((r) => resolved === path.resolve(r) || resolved.startsWith(path.resolve(r) + path.sep));
}

export function registerApi(app: FastifyInstance) {
  // ---------------------------------------------------------------- auth
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/api/') || req.url.startsWith('/api/login') || req.url.startsWith('/api/session')) return;
    if (!isAuthed(req)) return reply.code(401).send({ error: 'auth' });
  });
  app.get('/api/session', async (req) => ({ authed: isAuthed(req), passwordRequired: settings().requirePassword && !!settings().passwordHash }));
  app.post('/api/login', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    if (!checkPassword(password ?? '')) return reply.code(401).send({ error: 'Contraseña incorrecta' });
    setSessionCookie(reply);
    return { ok: true };
  });
  app.post('/api/logout', async (_req, reply) => {
    clearSessionCookie(reply);
    return { ok: true };
  });
  app.post('/api/password', async (req, reply) => {
    const { password } = (req.body ?? {}) as { password?: string };
    setPassword(password ?? '');
    if (password) setSessionCookie(reply);
    return { ok: true };
  });

  // ---------------------------------------------------------------- summary
  app.get('/api/summary', async () => {
    const counts = get<any>(`SELECT COUNT(*) AS tracks, COUNT(DISTINCT NULLIF(album_n,'')) AS albums,
      COUNT(DISTINCT NULLIF(artist_n,'')) AS artists, SUM(duration) AS seconds, SUM(hidden) AS hidden,
      SUM(audiobook) AS audiobook, SUM(transcode != 'none') AS transcoded FROM tracks`);
    const genres = get<{ n: number }>('SELECT COUNT(DISTINCT genre_n) AS n FROM track_genres')!.n;
    const s = settings();
    const devices = all(`SELECT d.*, t.title, t.artist, t.album, t.id AS track_id, t.has_art, t.duration, q.name AS queue_name
      FROM devices d LEFT JOIN queue_items qi ON qi.queue_id = d.queue_id AND qi.pos = d.pos
      LEFT JOIN tracks t ON t.id = qi.track_id LEFT JOIN queues q ON q.id = d.queue_id ORDER BY d.last_seen DESC`);
    const recent = all(`SELECT id, title, artist, album, has_art, last_played FROM tracks WHERE last_played > 0
      ORDER BY last_played DESC LIMIT 12`);
    const lastAlexa = get<{ ts: number }>("SELECT MAX(ts) AS ts FROM history WHERE utterance NOT LIKE '(prueba%'")?.ts ?? 0;
    return {
      ...counts, genres,
      folders: get<{ n: number }>('SELECT COUNT(*) AS n FROM folders')!.n,
      playlists: get<{ n: number }>('SELECT COUNT(*) AS n FROM playlists')!.n,
      scanning: isScanning(),
      ffmpeg: await ffmpegAvailable(),
      publicUrl: s.publicUrl,
      skillConfigured: !!s.skillId,
      lastAlexaRequest: lastAlexa,
      started, version: '1.0.0', os: `${os.type()} ${os.release()}`, node: process.version,
      devices, recent,
      setup: {
        folders: get<{ n: number }>('SELECT COUNT(*) AS n FROM folders')!.n > 0,
        publicUrl: !!s.publicUrl,
        skill: !!s.skillId,
        firstRequest: lastAlexa > 0,
      },
    };
  });

  // ---------------------------------------------------------------- messages
  app.get('/api/messages', async (req) => listMessages(Number((req.query as any).after ?? 0), Number((req.query as any).limit ?? 100)));
  app.delete('/api/messages/:id', async (req) => (clearMessage(Number((req.params as any).id)), { ok: true }));
  app.delete('/api/messages', async () => (clearAllMessages(), { ok: true }));

  // ---------------------------------------------------------------- folders
  app.get('/api/folders', async () => all('SELECT * FROM folders ORDER BY created_at'));
  app.post('/api/folders', async (req, reply) => {
    const { path: p, label } = (req.body ?? {}) as { path: string; label?: string };
    const folder = path.resolve(p ?? '');
    if (!p || !fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) return reply.code(400).send({ error: 'La carpeta no existe dentro del contenedor' });
    const existing = all<{ path: string }>('SELECT path FROM folders');
    if (existing.some((f) => folder === f.path || folder.startsWith(f.path + path.sep) || f.path.startsWith(folder + path.sep))) {
      return reply.code(400).send({ error: 'Esa carpeta ya está incluida (o contiene otra ya añadida)' });
    }
    const id = crypto.randomUUID();
    run('INSERT INTO folders (id, path, label, created_at) VALUES (?, ?, ?, ?)', id, folder, (label ?? '').trim(), Date.now());
    requestScan(id);
    watchFolders();
    return get('SELECT * FROM folders WHERE id = ?', id);
  });
  app.patch('/api/folders/:id', async (req) => {
    const { label } = (req.body ?? {}) as { label?: string };
    run('UPDATE folders SET label = ? WHERE id = ?', (label ?? '').trim(), (req.params as any).id);
    return get('SELECT * FROM folders WHERE id = ?', (req.params as any).id);
  });
  app.delete('/api/folders/:id', async (req) => {
    run('DELETE FROM folders WHERE id = ?', (req.params as any).id);
    watchFolders();
    return { ok: true };
  });
  app.post('/api/folders/:id/rescan', async (req) => (requestScan((req.params as any).id), { ok: true }));
  app.post('/api/rescan', async (req) => {
    const { clearHistory } = (req.body ?? {}) as { clearHistory?: boolean };
    if (clearHistory) run("UPDATE tracks SET checksum = ''");
    requestScanAll();
    return { ok: true };
  });
  app.get('/api/folders/:id/log', async (req, reply) => {
    const file = folderLogPath((req.params as any).id);
    if (!fs.existsSync(file)) return reply.code(404).send({ error: 'Sin registro todavía' });
    return reply.type('text/plain; charset=utf-8').send(fs.createReadStream(file));
  });
  app.get('/api/browse', async (req, reply) => {
    const dir = (req.query as any).dir as string | undefined;
    if (!dir) {
      return { dir: '', parent: null, entries: config.mediaRoots.filter((r) => fs.existsSync(r)).map((r) => ({ name: r, path: r })) };
    }
    if (!inRoots(dir)) return reply.code(400).send({ error: 'Fuera de las carpetas montadas' });
    const entries = (await fsp.readdir(dir, { withFileTypes: true }))
      .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !e.name.startsWith('@') && !e.name.startsWith('#'))
      .map((e) => ({ name: e.name, path: path.join(dir, e.name) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const parent = config.mediaRoots.some((r) => path.resolve(r) === path.resolve(dir)) ? '' : path.dirname(dir);
    return { dir, parent, entries };
  });

  // ---------------------------------------------------------------- library
  app.get('/api/tracks', async (req) => {
    const q = req.query as any;
    const page = Math.max(0, Number(q.page ?? 0));
    const size = Math.min(500, Math.max(10, Number(q.size ?? 50)));
    const sort = SORTS[q.sort as string] ?? 'artist_n, album_n, disc, track_no';
    const order = q.order === 'desc' ? 'DESC' : 'ASC';
    const where: string[] = [];
    const params: any[] = [];
    if (q.q) {
      const like = `%${String(q.q).toLowerCase()}%`;
      where.push('(lower(title) LIKE ? OR lower(artist) LIKE ? OR lower(album) LIKE ? OR lower(genre) LIKE ? OR lower(path) LIKE ? OR title_n LIKE ? OR artist_n LIKE ? OR album_n LIKE ?)');
      params.push(like, like, like, like, like, like, like, like);
    }
    if (q.album !== undefined) { where.push('album_n = (SELECT album_n FROM tracks WHERE album = ? LIMIT 1)'); params.push(q.album); }
    if (q.artist !== undefined) { where.push('(artist = ? OR album_artist = ?)'); params.push(q.artist, q.artist); }
    if (q.genre !== undefined) { where.push('id IN (SELECT track_id FROM track_genres WHERE genre = ?)'); params.push(q.genre); }
    if (q.hidden === '1') where.push('hidden = 1');
    if (q.hidden === '0') where.push('hidden = 0');
    if (q.audiobook === '1') where.push('audiobook = 1');
    if (q.transcode === '1') where.push("transcode != 'none'");
    if (q.folder) { where.push('folder_id = ?'); params.push(q.folder); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM tracks ${w}`, ...params)!.n;
    const sortCols = sort.split(',').map((c, i) => `${c.trim()} ${i === 0 ? order : 'ASC'}`).join(', ');
    const rows = all(`SELECT id, title, artist, album_artist, album, genre, year, disc, track_no, duration, codec, transcode,
      hidden, audiobook, play_count, has_art, path, indexed_at FROM tracks ${w} ORDER BY ${sortCols}, path LIMIT ? OFFSET ?`,
      ...params, size, page * size);
    return { total, page, size, rows };
  });

  app.get('/api/groups/:type', async (req, reply) => {
    const type = (req.params as any).type as string;
    const q = req.query as any;
    const like = q.q ? `%${String(q.q).toLowerCase()}%` : '%';
    const page = Math.max(0, Number(q.page ?? 0));
    const size = Math.min(500, Math.max(10, Number(q.size ?? 60)));
    let sql: string;
    if (type === 'albums') {
      sql = `SELECT album AS name, MAX(album_artist) AS album_artist, MAX(artist) AS artist, MAX(year) AS year, COUNT(*) AS tracks,
        MAX(audiobook) AS audiobook, SUM(hidden) AS hidden, MIN(CASE WHEN has_art THEN id END) AS art_id, MIN(id) AS first_id
        FROM tracks WHERE album != '' AND (lower(album) LIKE ? OR album_n LIKE ? OR lower(album_artist) LIKE ? OR lower(artist) LIKE ?)
        GROUP BY album_n ORDER BY album_n`;
    } else if (type === 'artists') {
      sql = `SELECT artist AS name, COUNT(*) AS tracks, COUNT(DISTINCT album_n) AS albums, MIN(CASE WHEN has_art THEN id END) AS art_id
        FROM tracks WHERE artist != '' AND (lower(artist) LIKE ? OR artist_n LIKE ? OR ? = ? )
        GROUP BY artist_n ORDER BY artist_n`;
    } else if (type === 'genres') {
      sql = `SELECT g.genre AS name, COUNT(*) AS tracks, COUNT(DISTINCT t.artist_n) AS artists, MIN(CASE WHEN t.has_art THEN t.id END) AS art_id
        FROM track_genres g JOIN tracks t ON t.id = g.track_id WHERE (lower(g.genre) LIKE ? OR g.genre_n LIKE ? OR ? = ?)
        GROUP BY g.genre_n ORDER BY g.genre_n`;
    } else return reply.code(404).send();
    const params = [like, like, like, like];
    const total = get<{ n: number }>(`SELECT COUNT(*) AS n FROM (${sql})`, ...params)!.n;
    return { total, page, size, rows: all(`${sql} LIMIT ? OFFSET ?`, ...params, size, page * size) };
  });

  const ids = (req: any) => ((req.body ?? {}) as { ids?: string[] }).ids ?? [];
  const inList = (n: number) => Array.from({ length: n }, () => '?').join(',');
  app.post('/api/tracks/hide', async (req) => {
    const list = ids(req);
    if (list.length) run(`UPDATE tracks SET hidden = 1 WHERE id IN (${inList(list.length)})`, ...list);
    return { ok: true };
  });
  app.post('/api/tracks/unhide', async (req) => {
    const list = ids(req);
    if (list.length) run(`UPDATE tracks SET hidden = 0 WHERE id IN (${inList(list.length)})`, ...list);
    return { ok: true };
  });
  app.post('/api/tracks/rescan', async (req) => {
    await rescanTracks(ids(req));
    return { ok: true };
  });
  app.post('/api/albums/audiobook', async (req) => {
    const { album, value } = (req.body ?? {}) as { album: string; value: boolean };
    run('UPDATE tracks SET audiobook = ? WHERE album_n = (SELECT album_n FROM tracks WHERE album = ? LIMIT 1)', value ? 1 : 0, album);
    return { ok: true };
  });
  /** "Selección actual": a queue Alexa plays with "pon la selección" (original SPECIAL_THIS). */
  app.post('/api/selection', async (req) => {
    const list = ids(req);
    const q = createQueue('la selección actual', list);
    run("INSERT OR REPLACE INTO settings (key, value) VALUES ('selectionQueue', ?)", JSON.stringify(q.id));
    return { ok: true, queueId: q.id, count: list.length };
  });
  /** Signed URL for the in-browser preview player. */
  app.get('/api/tracks/:id/url', async (req) => {
    const id = (req.params as any).id;
    return { url: `/stream/${id}?k=${sign(id)}` };
  });

  // ---------------------------------------------------------------- playlists
  app.get('/api/playlists', async () => all(`SELECT p.*, (SELECT COUNT(*) FROM playlist_tracks pt WHERE pt.playlist_id = p.id) AS tracks,
      (SELECT SUM(t.duration) FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id) AS seconds,
      (SELECT t.id FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = p.id AND t.has_art ORDER BY pt.position LIMIT 1) AS art_id
      FROM playlists p ORDER BY p.kind = 'webstream', lower(p.name)`));
  app.post('/api/playlists', async (req, reply) => {
    const { name, streamUrl } = (req.body ?? {}) as { name?: string; streamUrl?: string };
    if (!name?.trim()) return reply.code(400).send({ error: 'Pon un nombre' });
    if (streamUrl && !/^https?:\/\//i.test(streamUrl)) return reply.code(400).send({ error: 'La URL debe empezar por http:// o https://' });
    const id = crypto.randomUUID();
    run('INSERT INTO playlists (id, name, kind, stream_url, created_at) VALUES (?, ?, ?, ?, ?)',
      id, name.trim(), streamUrl ? 'webstream' : 'user', streamUrl ?? '', Date.now());
    return get('SELECT * FROM playlists WHERE id = ?', id);
  });
  app.patch('/api/playlists/:id', async (req) => {
    const { name, streamUrl } = (req.body ?? {}) as { name?: string; streamUrl?: string };
    const id = (req.params as any).id;
    if (name?.trim()) run('UPDATE playlists SET name = ? WHERE id = ?', name.trim(), id);
    if (streamUrl !== undefined) run("UPDATE playlists SET stream_url = ? WHERE id = ? AND kind = 'webstream'", streamUrl, id);
    return get('SELECT * FROM playlists WHERE id = ?', id);
  });
  app.delete('/api/playlists/:id', async (req) => (run('DELETE FROM playlists WHERE id = ?', (req.params as any).id), { ok: true }));
  app.get('/api/playlists/:id/tracks', async (req) => all(`SELECT pt.position, t.id, t.title, t.artist, t.album, t.duration, t.has_art, t.hidden
      FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id WHERE pt.playlist_id = ? ORDER BY pt.position`, (req.params as any).id));
  app.post('/api/playlists/:id/tracks', async (req) => {
    const id = (req.params as any).id;
    const list = ids(req);
    tx(() => {
      let pos = get<{ n: number }>('SELECT COALESCE(MAX(position) + 1, 0) AS n FROM playlist_tracks WHERE playlist_id = ?', id)!.n;
      for (const t of list) run('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)', id, pos++, t);
    });
    return { ok: true };
  });
  /** Replace order / remove tracks: body { order: string[] } = track ids in the new order. */
  app.put('/api/playlists/:id/tracks', async (req) => {
    const id = (req.params as any).id;
    const { order } = (req.body ?? {}) as { order: string[] };
    tx(() => {
      run('DELETE FROM playlist_tracks WHERE playlist_id = ?', id);
      order.forEach((t, i) => run('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)', id, i, t));
    });
    return { ok: true };
  });
  app.get('/api/playlists/:id/export.m3u', async (req, reply) => {
    const id = (req.params as any).id;
    const p = get<{ name: string }>('SELECT name FROM playlists WHERE id = ?', id);
    if (!p) return reply.code(404).send();
    const rows = all<any>(`SELECT t.path, t.title, t.artist, t.duration FROM playlist_tracks pt JOIN tracks t ON t.id = pt.track_id
      WHERE pt.playlist_id = ? ORDER BY pt.position`, id);
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(p.name)}.m3u"`);
    return reply.type('audio/x-mpegurl; charset=utf-8').send(m3uExport(p.name, rows));
  });

  // ---------------------------------------------------------------- devices
  app.get('/api/devices', async () => all('SELECT * FROM devices ORDER BY last_seen DESC'));
  app.patch('/api/devices/:id', async (req) => {
    const { name } = (req.body ?? {}) as { name?: string };
    run('UPDATE devices SET name = ? WHERE id = ?', (name ?? '').trim(), (req.params as any).id);
    return { ok: true };
  });
  app.delete('/api/devices/:id', async (req) => (run('DELETE FROM devices WHERE id = ?', (req.params as any).id), { ok: true }));

  // ---------------------------------------------------------------- history & learnings
  app.get('/api/history', async (req) => {
    const q = req.query as any;
    const rows = all<any>(`SELECT * FROM history ${q.failed === '1' ? 'WHERE success = 0' : ''} ORDER BY id DESC LIMIT ?`, Number(q.limit ?? 200));
    return rows.map((r) => ({ ...r, criteria: JSON.parse(r.criteria), found: JSON.parse(r.found), trained: JSON.parse(r.trained) }));
  });
  app.delete('/api/history', async () => (run('DELETE FROM history'), { ok: true }));
  const LKEYS = ['album', 'artist', 'genre', 'song', 'playlist', 'book', 'query'];
  const learningCols = (body: any) => {
    const crit = LKEYS.map((k) => (body?.criteria?.[k] ?? '').trim() || null);
    const trained = LKEYS.filter((k) => k !== 'query').map((k) => (body?.trained?.[k] ?? '').trim() || null);
    return { crit, trained };
  };
  app.get('/api/learnings', async () => all<any>('SELECT * FROM learnings ORDER BY created_at DESC').map((l) => ({
    id: l.id, created_at: l.created_at,
    criteria: Object.fromEntries(LKEYS.map((k) => [k, l[`criteria_${k}`]]).filter(([, v]) => v)),
    trained: Object.fromEntries(LKEYS.filter((k) => k !== 'query').map((k) => [k, l[`trained_${k}`]]).filter(([, v]) => v)),
  })));
  app.post('/api/learnings', async (req, reply) => {
    const { crit, trained } = learningCols(req.body);
    if (!crit.some(Boolean) || !trained.some(Boolean)) return reply.code(400).send({ error: 'Rellena lo que se pidió y lo que debía sonar' });
    const id = crypto.randomUUID();
    run(`INSERT INTO learnings (id, criteria_album, criteria_artist, criteria_genre, criteria_song, criteria_playlist, criteria_book, criteria_query,
      trained_album, trained_artist, trained_genre, trained_song, trained_playlist, trained_book, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      id, ...crit, ...trained, Date.now());
    return { id };
  });
  app.put('/api/learnings/:id', async (req) => {
    const { crit, trained } = learningCols(req.body);
    run(`UPDATE learnings SET criteria_album=?, criteria_artist=?, criteria_genre=?, criteria_song=?, criteria_playlist=?, criteria_book=?, criteria_query=?,
      trained_album=?, trained_artist=?, trained_genre=?, trained_song=?, trained_playlist=?, trained_book=? WHERE id = ?`,
      ...crit, ...trained, (req.params as any).id);
    return { ok: true };
  });
  app.delete('/api/learnings/:id', async (req) => (run('DELETE FROM learnings WHERE id = ?', (req.params as any).id), { ok: true }));

  app.get('/api/bookmarks', async () => listBookmarks());
  app.delete('/api/bookmarks/:hash', async (req) => (clearBookmark((req.params as any).hash), { ok: true }));

  // ---------------------------------------------------------------- settings & maintenance
  app.get('/api/settings', async () => ({ ...publicSettings(), mediaRoots: config.mediaRoots, envPublicUrl: !!config.publicUrl }));
  app.put('/api/settings', async (req) => {
    const before = settings();
    const next = updateSettings((req.body ?? {}) as any);
    if (before.extraFormats !== next.extraFormats) requestScanAll();
    if (before.transcodeBitrate !== next.transcodeBitrate || before.replayGain !== next.replayGain) await clearTranscodeCache();
    return publicSettings();
  });
  app.post('/api/maintenance/clear-art', async () => (await clearArtCache(), { ok: true }));
  app.post('/api/maintenance/clear-transcodes', async () => (await clearTranscodeCache(), { ok: true }));
  app.post('/api/maintenance/clear-all', async () => {
    tx(() => {
      run('DELETE FROM tracks');
      run('DELETE FROM queues');
      run('DELETE FROM bookmarks');
      run("DELETE FROM playlists WHERE kind = 'file'");
    });
    await clearArtCache();
    await clearTranscodeCache();
    requestScanAll();
    return { ok: true };
  });

  // ---------------------------------------------------------------- alexa helpers
  app.get('/api/alexa/model', async (_req, reply) => {
    reply.header('Content-Disposition', 'attachment; filename="modelo-interaccion-es.json"');
    return reply.type('application/json').send(JSON.stringify(buildInteractionModel(), null, 2));
  });
  app.post('/api/alexa/test', async (req) => explain((req.body ?? {}) as Criteria));
  app.get('/api/alexa/check', async () => {
    const s = settings();
    if (!s.publicUrl) return { ok: false, error: 'Falta la URL pública' };
    try {
      const res = await fetch(`${s.publicUrl}/health`, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as any;
      return { ok: res.ok && body?.app === 'mi-musica', status: res.status };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });
}
