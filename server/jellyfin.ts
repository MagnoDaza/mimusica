/**
 * Jellyfin "Play on" target: every Echo shows up in Jellyfin's cast menu.
 * Alexa can't be woken up by a server, so what you pick there goes into the Echo's queue
 * (right after the next song) when it is playing, or becomes "la selección" when it isn't.
 */
import crypto from 'node:crypto';
import { all, get, run } from './db.ts';
import { settings } from './settings.ts';
import { createQueue, navigate, insertTracks, appendAfterRand, getQueue } from './queue.ts';
import { addMessage } from './messages.ts';
import { norm } from './text.ts';
import { logger } from './log.ts';

const log = logger('jellyfin');
const VERSION = '1.0.0';

type Device = { id: string; name: string; queue_id: string; pos: number; state: string; shuffle: number; loop: number };
type Login = { token: string; userId: string };

function base() {
  return settings().jellyfinUrl.trim().replace(/\/+$/, '');
}
const jfDeviceId = (echoId: string) => `mimusica-${crypto.createHash('sha1').update(echoId).digest('hex').slice(0, 16)}`;
const authHeader = (name: string, devId: string, token?: string) =>
  // Jellyfin URL-decodes these values; raw non-ASCII («ú», «ñ» in Echo names) gets a 400.
  `MediaBrowser Client="${encodeURIComponent('Mi Música')}", Device="${encodeURIComponent(name)}", DeviceId="${devId}", Version="${VERSION}"${token ? `, Token="${token}"` : ''}`;

async function jf<T = any>(p: string, auth: string, body?: unknown): Promise<T> {
  const res = await fetch(base() + p, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: auth, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Jellyfin respondió ${res.status} en ${p.split('?')[0]}`);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

// ---------------------------------------------------------------- Jellyfin items → our tracks

type JfItem = { Id: string; Type: string; Path?: string; Name?: string; AlbumArtist?: string; Artists?: string[] };

async function expand(ids: string[], login: Login, auth: string): Promise<JfItem[]> {
  const q = `/Users/${login.userId}/Items?Ids=${ids.join(',')}&Fields=Path`;
  const items = (await jf<{ Items: JfItem[] }>(q, auth)).Items ?? [];
  const byId = new Map(items.map((i) => [i.Id, i]));
  const out: JfItem[] = [];
  for (const id of ids) {
    const it = byId.get(id);
    if (!it) continue;
    if (it.Type === 'Audio') { out.push(it); continue; }
    // Album, artist, playlist, folder or genre: its songs, in album order.
    const filter = it.Type === 'MusicArtist' ? `ArtistIds=${it.Id}` : it.Type === 'MusicGenre' ? `GenreIds=${it.Id}` : `ParentId=${it.Id}`;
    const sort = it.Type === 'Playlist' ? '' : '&SortBy=AlbumArtist,Album,ParentIndexNumber,IndexNumber,SortName';
    const kids = await jf<{ Items: JfItem[] }>(`/Users/${login.userId}/Items?${filter}&Recursive=true&IncludeItemTypes=Audio&Fields=Path${sort}&Limit=2000`, auth);
    out.push(...(kids.Items ?? []));
  }
  return out;
}

const tail = (p: string, n: number) => p.replace(/\\/g, '/').split('/').filter(Boolean).slice(-n).join('/').toLowerCase();

/** Same file seen from two containers: match by the last folders of the path, then by title + artist. */
export function matchTracks(items: { Path?: string; Name?: string; AlbumArtist?: string; Artists?: string[] }[]) {
  const tracks = all<{ id: string; path: string; title: string; artist: string }>('SELECT id, path, title, artist FROM tracks WHERE hidden = 0');
  const by3 = new Map<string, string>(), by2 = new Map<string, string>(), byName = new Map<string, string>();
  for (const t of tracks) {
    by3.set(tail(t.path, 3), t.id);
    by2.set(tail(t.path, 2), t.id);
    byName.set(`${norm(t.title)}|${norm(t.artist)}`, t.id);
  }
  const ids: string[] = [];
  let missing = 0;
  for (const it of items) {
    const p = it.Path ?? '';
    const name = `${norm(it.Name ?? '')}|${norm(it.AlbumArtist || it.Artists?.[0] || '')}`;
    const id = (p && (by3.get(tail(p, 3)) ?? by2.get(tail(p, 2)))) || byName.get(name);
    if (id) ids.push(id);
    else missing++;
  }
  return { ids, missing };
}

const songs = (n: number) => (n === 1 ? '1 canción' : `${n} canciones`);

/** Put the songs where the Echo will reach them. Returns what to tell the user. */
export function deliver(echoId: string, trackIds: string[], command: string) {
  const d = get<Device>('SELECT * FROM devices WHERE id = ?', echoId);
  if (!d || !trackIds.length) return '';
  const q = d.queue_id ? getQueue(d.queue_id) : undefined;
  if (d.state === 'playing' && q && !q.stream_url) {
    if (command === 'PlayLast') insertTracks(q.id, trackIds);
    else {
      // Alexa has (or will soon have) the next song buffered: ours go right after it.
      const next = navigate(q.id, d.pos, 'next', { loop: !!d.loop, shuffle: !!d.shuffle });
      if (!next) insertTracks(q.id, trackIds);
      else if (d.shuffle && !q.audiobook) appendAfterRand(q.id, trackIds, next.item.rand_order);
      else insertTracks(q.id, trackIds, next.item.pos);
    }
    const where = command === 'PlayLast' ? 'al final de la cola' : 'después de la siguiente canción';
    return `${songs(trackIds.length)} ${trackIds.length === 1 ? 'añadida' : 'añadidas'} ${where} en ${d.name}.`;
  }
  const sel = createQueue('lo que elegiste en Jellyfin', trackIds);
  run("INSERT OR REPLACE INTO settings (key, value) VALUES ('selectionQueue', ?)", JSON.stringify(sel.id));
  return `${d.name} no está sonando: ${songs(trackIds.length)} ${trackIds.length === 1 ? 'lista' : 'listas'}. Di «Alexa, pide a ${settings().invocationName} que ponga la selección».`;
}

// ---------------------------------------------------------------- one Jellyfin session per Echo

class EchoSession {
  ws?: WebSocket;
  keepAlive?: ReturnType<typeof setInterval>;
  retry?: ReturnType<typeof setTimeout>;
  login?: Login;
  stopped = false;
  status = 'conectando…';
  readonly devId: string;
  readonly echoId: string;
  readonly name: string;
  constructor(echoId: string, name: string) {
    this.echoId = echoId;
    this.name = name;
    this.devId = jfDeviceId(echoId);
    void this.connect();
  }

  get auth() {
    return authHeader(this.name, this.devId, this.login?.token);
  }

  async connect() {
    if (this.stopped) return;
    try {
      const s = settings();
      if (!this.login) {
        const r = await jf<any>('/Users/AuthenticateByName', this.auth, { Username: s.jellyfinUser, Pw: s.jellyfinPassword });
        this.login = { token: r.AccessToken, userId: r.User.Id };
      }
      await jf('/Sessions/Capabilities/Full', this.auth, {
        PlayableMediaTypes: ['Audio'], SupportedCommands: [], SupportsMediaControl: true, SupportsPersistentIdentifier: true,
      });
      // Jellyfin 12 dropped the old "api_key" parameter: send "ApiKey" plus the header (older servers read that).
      const wsUrl = `${base().replace(/^http/, 'ws')}/socket?ApiKey=${this.login.token}&deviceId=${this.devId}`;
      const ws = new (WebSocket as any)(wsUrl, { headers: { Authorization: this.auth } }) as WebSocket;
      this.ws = ws;
      ws.onopen = () => { this.status = 'conectado'; log.info(`${this.name}: visible en Jellyfin`); };
      ws.onmessage = (ev) => void this.onMessage(String(ev.data));
      ws.onclose = () => this.later('desconectado, reintentando…');
      ws.onerror = () => {}; // onclose follows
    } catch (err) {
      const msg = (err as Error).message;
      if (/401/.test(msg)) this.login = undefined;
      this.later(`error: ${msg}`);
    }
  }

  later(status: string) {
    this.status = status;
    clearInterval(this.keepAlive);
    if (this.stopped || this.retry) return;
    this.retry = setTimeout(() => { this.retry = undefined; void this.connect(); }, 30_000);
  }

  async onMessage(raw: string) {
    let m: any;
    try { m = JSON.parse(raw); } catch { return; }
    if (m.MessageType === 'ForceKeepAlive') {
      clearInterval(this.keepAlive);
      const every = Math.max(5, Number(m.Data) || 60) * 500;
      this.keepAlive = setInterval(() => this.ws?.send(JSON.stringify({ MessageType: 'KeepAlive' })), every);
      return;
    }
    if (m.MessageType !== 'Play' || !this.login) return;
    try {
      const ids: string[] = m.Data?.ItemIds ?? [];
      const start = Number(m.Data?.StartIndex ?? 0) || 0;
      const items = await expand(ids, this.login, this.auth);
      const { ids: tracks, missing } = matchTracks(items.slice(start));
      if (!tracks.length) {
        addMessage('alexa', 'warning', `Jellyfin: no encontré esas canciones en Mi Música`,
          'Comprueba que Mi Música tiene montada la misma carpeta de música que Jellyfin.');
        return;
      }
      const said = deliver(this.echoId, tracks, m.Data?.PlayCommand ?? 'PlayNow');
      addMessage('alexa', 'info', `Desde Jellyfin: ${said}`, missing ? `${missing} canciones no estaban en tu biblioteca de Mi Música.` : '');
    } catch (err) {
      addMessage('alexa', 'error', 'Jellyfin: no pude leer lo que elegiste', (err as Error).message);
    }
  }

  stop() {
    this.stopped = true;
    clearInterval(this.keepAlive);
    clearTimeout(this.retry);
    try { this.ws?.close(); } catch { /* already closed */ }
    if (this.login) void jf('/Sessions/Logout', this.auth, {}).catch(() => {});
  }
}

const sessions = new Map<string, EchoSession>();
let configKey = '';

/** Keep one session per Echo while Jellyfin is configured. Cheap: call it as often as you like. */
export function syncJellyfin() {
  const s = settings();
  const key = `${base()}|${s.jellyfinUser}|${s.jellyfinPassword}`;
  const on = !!(base() && s.jellyfinUser);
  if (key !== configKey) {
    for (const x of sessions.values()) x.stop();
    sessions.clear();
    configKey = key;
  }
  const echoes = on ? all<{ id: string; name: string }>('SELECT id, name FROM devices') : [];
  const want = new Map(echoes.map((e) => [e.id, `${e.name || 'Echo'} (Alexa)`]));
  for (const [id, x] of sessions) {
    if (want.get(id) !== x.name) { x.stop(); sessions.delete(id); }
  }
  for (const [id, name] of want) if (!sessions.has(id)) sessions.set(id, new EchoSession(id, name));
}

export function jellyfinStatus() {
  return [...sessions.values()].map((x) => ({ name: x.name, status: x.status }));
}

export function startJellyfin() {
  syncJellyfin();
  setInterval(syncJellyfin, 60_000).unref();
}

