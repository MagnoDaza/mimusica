import crypto from 'node:crypto';
import { all, get, run } from '../db.ts';
import { settings, sign } from '../settings.ts';
import { resolve, findPlaylist, type Criteria, type PlayPlan } from '../search.ts';
import {
  navigate, itemAt, getQueue, createQueue, saveBookmark, getBookmark, findPosForTrack, LAST_BOOKMARK,
  type Track, type Step,
} from '../queue.ts';
import { addMessage } from '../messages.ts';
import { startTranscode } from '../media.ts';
import { norm, similarity } from '../text.ts';
import { logger } from '../log.ts';
import { t } from './i18n.ts';

const log = logger('alexa');

// ---------------------------------------------------------------- devices

type Device = { id: string; name: string; queue_id: string; pos: number; offset_ms: number; state: string; shuffle: number; loop: number };

function device(id: string): Device {
  let d = get<Device>('SELECT * FROM devices WHERE id = ?', id);
  if (!d) {
    const n = get<{ n: number }>('SELECT COUNT(*) AS n FROM devices')!.n;
    run('INSERT INTO devices (id, name, last_seen) VALUES (?, ?, ?)', id, `Echo ${n + 1}`, Date.now());
    addMessage('alexa', 'info', `Nuevo dispositivo Alexa: Echo ${n + 1}`, 'Puedes ponerle un nombre en la pestaña Dispositivos.');
    d = get<Device>('SELECT * FROM devices WHERE id = ?', id)!;
  }
  run('UPDATE devices SET last_seen = ? WHERE id = ?', Date.now(), id);
  return d;
}

function updateDevice(id: string, patch: Partial<Device>) {
  const keys = Object.keys(patch);
  if (!keys.length) return;
  run(`UPDATE devices SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`,
    ...keys.map((k) => (patch as any)[k]), Date.now(), id);
}

// ---------------------------------------------------------------- tokens & urls

const tokenFor = (queueId: string, pos: number | 'radio') => `${queueId}~${pos}`;
function parseToken(token?: string): { queueId: string; pos: number | 'radio' } | undefined {
  if (!token) return undefined;
  const [queueId, p] = token.split('~');
  if (!queueId || p === undefined) return undefined;
  return { queueId, pos: p === 'radio' ? 'radio' : Number(p) };
}

function base() {
  return settings().publicUrl;
}

export function streamUrl(trackId: string) {
  return `${base()}/stream/${trackId}?k=${sign(trackId)}`;
}
export function artUrl(trackId: string, size: number) {
  return `${base()}/art/${trackId}?s=${size}&k=${sign(trackId)}`;
}

// ---------------------------------------------------------------- response builders

type Directive = Record<string, unknown>;
type Res = { version: '1.0'; response: Record<string, unknown> };

function respond(opts: { speech?: string; reprompt?: string; directives?: Directive[]; end?: boolean } = {}): Res {
  const response: Record<string, unknown> = {};
  if (opts.speech) response.outputSpeech = { type: 'PlainText', text: opts.speech };
  if (opts.reprompt) response.reprompt = { outputSpeech: { type: 'PlainText', text: opts.reprompt } };
  if (opts.directives?.length) response.directives = opts.directives;
  if (opts.end !== undefined) response.shouldEndSession = opts.end;
  return { version: '1.0', response };
}

function playDirective(track: Track, token: string, offsetMs: number, behavior: 'REPLACE_ALL' | 'ENQUEUE' | 'REPLACE_ENQUEUED', expectedPrevious?: string): Directive {
  const metadata: Record<string, unknown> = {
    title: track.title,
    subtitle: [track.artist, track.album].filter(Boolean).join(' · '),
  };
  if (settings().sendAlbumArt && track.has_art) {
    metadata.art = { sources: [{ url: artUrl(track.id, 512), widthPixels: 512, heightPixels: 512 }] };
    metadata.backgroundImage = { sources: [{ url: artUrl(track.id, 1080) }] };
  }
  return {
    type: 'AudioPlayer.Play',
    playBehavior: behavior,
    audioItem: {
      stream: {
        url: streamUrl(track.id),
        token,
        offsetInMilliseconds: Math.max(0, Math.floor(offsetMs)),
        ...(behavior === 'ENQUEUE' && expectedPrevious ? { expectedPreviousToken: expectedPrevious } : {}),
      },
      metadata,
    },
  };
}

function radioDirective(queueId: string, name: string): Directive {
  return {
    type: 'AudioPlayer.Play',
    playBehavior: 'REPLACE_ALL',
    audioItem: {
      stream: { url: `${base()}/radio/${queueId}?k=${sign(queueId)}`, token: tokenFor(queueId, 'radio'), offsetInMilliseconds: 0 },
      metadata: { title: name, subtitle: 'Radio' },
    },
  };
}

const stopDirective = (): Directive => ({ type: 'AudioPlayer.Stop' });
const clearEnqueued = (): Directive => ({ type: 'AudioPlayer.ClearQueue', clearBehavior: 'CLEAR_ENQUEUED' });

/** Kick off transcoding early so the stream is ready when Alexa asks for it. */
function prepare(track: Track) {
  if (track.transcode !== 'none') {
    try {
      startTranscode(track.id, track.path, track.checksum, track.transcode);
    } catch (err) {
      log.warn('prepare failed', err);
    }
  }
}

// ---------------------------------------------------------------- playback helpers

function startPlan(deviceId: string, plan: PlayPlan, speechPrefix = true): Res {
  const d = device(deviceId);
  const q = plan.queue;
  if (q.stream_url) {
    updateDevice(deviceId, { queue_id: q.id, pos: 0, offset_ms: 0, state: 'playing' });
    return respond({ speech: speechPrefix ? t('playing', q.name) : undefined, directives: [radioDirective(q.id, q.name)], end: true });
  }
  const step: Step = plan.startPos !== undefined ? 'current' : 'first';
  const hit = navigate(q.id, plan.startPos, step, { loop: !!d.loop, shuffle: !!d.shuffle && !q.audiobook && plan.startPos === undefined });
  if (!hit) return respond({ speech: t('nothingPlayable'), end: true });
  prepare(hit.track);
  updateDevice(deviceId, { queue_id: q.id, pos: hit.item.pos, offset_ms: plan.startOffsetMs ?? 0, state: 'playing' });
  const resumed = plan.startOffsetMs ? t('resuming', q.name) : t('playing', q.name);
  return respond({
    speech: speechPrefix ? resumed : undefined,
    directives: [playDirective(hit.track, tokenFor(q.id, hit.item.pos), plan.startOffsetMs ?? 0, 'REPLACE_ALL')],
    end: true,
  });
}

function jump(deviceId: string, step: Step, fromToken?: string): Res {
  const d = device(deviceId);
  const tok = parseToken(fromToken) ?? (d.queue_id ? { queueId: d.queue_id, pos: d.pos } : undefined);
  if (!tok || tok.pos === 'radio') return respond({ speech: t('nothingToNavigate'), end: true });
  const hit = navigate(tok.queueId, tok.pos, step, { loop: !!d.loop, shuffle: !!d.shuffle });
  if (!hit) return respond({ speech: step === 'previous' ? t('atStart') : t('atEnd'), end: true });
  prepare(hit.track);
  updateDevice(deviceId, { queue_id: tok.queueId, pos: hit.item.pos, offset_ms: 0, state: 'playing' });
  return respond({ directives: [playDirective(hit.track, tokenFor(tok.queueId, hit.item.pos), 0, 'REPLACE_ALL')], end: true });
}

function resumeDevice(deviceId: string, offsetOverride?: number): Res {
  const d = device(deviceId);
  if (!d.queue_id || !getQueue(d.queue_id)) return resumeLast(deviceId);
  const q = getQueue(d.queue_id)!;
  if (q.stream_url) return respond({ directives: [radioDirective(q.id, q.name)], end: true });
  const hit = itemAt(d.queue_id, d.pos);
  if (!hit) return resumeLast(deviceId);
  prepare(hit.track);
  updateDevice(deviceId, { state: 'playing' });
  return respond({
    directives: [playDirective(hit.track, tokenFor(d.queue_id, d.pos), offsetOverride ?? d.offset_ms, 'REPLACE_ALL')],
    end: true,
  });
}

/** "Continúa donde lo dejé" — the original's SPECIAL_LAST. */
function resumeLast(deviceId: string): Res {
  const bm = getBookmark(LAST_BOOKMARK);
  if (bm?.queue_id && getQueue(bm.queue_id)) {
    const pos = findPosForTrack(bm.queue_id, bm.track_id);
    if (pos !== undefined) return startPlan(deviceId, { queue: getQueue(bm.queue_id)!, startPos: pos, startOffsetMs: bm.offset_ms, trackCount: 0 });
  }
  const plan = resolve({}, { deviceId, utterance: 'continuar' });
  return plan ? startPlan(deviceId, plan) : respond({ speech: t('emptyLibrary'), end: true });
}

function currentTrack(deviceId: string, token?: string): { track: Track; queueId: string; pos: number } | undefined {
  const d = device(deviceId);
  const tok = parseToken(token) ?? (d.queue_id ? { queueId: d.queue_id, pos: d.pos } : undefined);
  if (!tok || tok.pos === 'radio') return undefined;
  const hit = itemAt(tok.queueId, tok.pos);
  return hit && { track: hit.track, queueId: tok.queueId, pos: tok.pos };
}

// ---------------------------------------------------------------- intents

function slot(intent: any, name: string): string | undefined {
  const s = intent?.slots?.[name];
  if (!s) return undefined;
  // Prefer the canonical value when the slot matched one of our catalogue values / synonyms.
  for (const r of s.resolutions?.resolutionsPerAuthority ?? []) {
    if (r.status?.code === 'ER_SUCCESS_MATCH' && r.values?.[0]?.value?.name) return r.values[0].value.name;
  }
  return s.value || undefined;
}

function criteriaFor(intentName: string, intent: any): Criteria | undefined {
  switch (intentName) {
    case 'PlayIntent': return { query: slot(intent, 'query') };
    case 'PlayArtistIntent': return { artist: slot(intent, 'artist') };
    case 'PlayAlbumIntent': return { album: slot(intent, 'album'), artist: slot(intent, 'artist') };
    case 'PlaySongIntent': return { song: slot(intent, 'song'), artist: slot(intent, 'artist') };
    case 'PlayGenreIntent': return { genre: slot(intent, 'genre') };
    case 'PlayPlaylistIntent': return { playlist: slot(intent, 'playlist'), shuffle: false };
    case 'ShufflePlaylistIntent': return { playlist: slot(intent, 'playlist'), shuffle: true };
    case 'ReadBookIntent': {
      const ch = Number(slot(intent, 'chapter'));
      return { book: slot(intent, 'book'), bookChapter: Number.isFinite(ch) && ch > 0 ? ch : undefined };
    }
    case 'PlayEverythingIntent': return {};
    default: return undefined;
  }
}

function describeCriteria(c: Criteria) {
  return c.query ?? c.book ?? c.playlist ?? [c.song, c.album, c.artist, c.genre].filter(Boolean).join(', ');
}

function handleIntent(deviceId: string, req: any, ctx: any): Res {
  const intent = req.intent;
  const name: string = intent?.name ?? '';
  const token: string | undefined = ctx?.AudioPlayer?.token;
  const d = device(deviceId);

  const criteria = criteriaFor(name, intent);
  if (criteria) {
    const asked = describeCriteria(criteria);
    if (name !== 'PlayEverythingIntent' && !asked) return respond({ speech: t('didntCatch'), reprompt: t('reprompt'), end: false });
    const plan = resolve(criteria, { deviceId, utterance: `${name}: ${asked}` });
    if (!plan) {
      addMessage('alexa', 'warning', `No se encontró "${asked}"`,
        'Revisa la pestaña Historial: puedes enseñarle qué debía sonar creando un aprendizaje.');
      return respond({ speech: t('notFound', asked), end: true });
    }
    return startPlan(deviceId, plan);
  }

  switch (name) {
    case 'PlaySelectionIntent': {
      const qid = get<{ value: string }>("SELECT value FROM settings WHERE key = 'selectionQueue'")?.value;
      const q = qid && getQueue(JSON.parse(qid));
      if (!q) return respond({ speech: t('noSelection'), end: true });
      return startPlan(deviceId, { queue: q, trackCount: 0 });
    }
    case 'ResumeLastIntent':
      return resumeLast(deviceId);
    case 'AMAZON.ResumeIntent':
      return resumeDevice(deviceId);
    case 'AMAZON.PauseIntent':
    case 'AMAZON.StopIntent':
    case 'AMAZON.CancelIntent':
      return respond({ directives: [stopDirective()], end: true });
    case 'AMAZON.NextIntent':
      return jump(deviceId, 'next', token);
    case 'AMAZON.PreviousIntent':
      return jump(deviceId, 'previous', token);
    case 'AMAZON.StartOverIntent':
    case 'AMAZON.RepeatIntent':
      return jump(deviceId, 'current', token);
    case 'AMAZON.ShuffleOnIntent':
    case 'AMAZON.ShuffleOffIntent':
    case 'AMAZON.LoopOnIntent':
    case 'AMAZON.LoopOffIntent': {
      const patch: Partial<Device> = name.includes('Shuffle')
        ? { shuffle: name.endsWith('OnIntent') ? 1 : 0 }
        : { loop: name.endsWith('OnIntent') ? 1 : 0 };
      updateDevice(deviceId, patch);
      const speech = t(name.replace('AMAZON.', '').replace('Intent', ''));
      // Re-plan what comes next under the new mode.
      const cur = parseToken(token);
      if (cur && cur.pos !== 'radio' && ctx?.AudioPlayer?.playerActivity === 'PLAYING') {
        const nd = { ...d, ...patch };
        const next = navigate(cur.queueId, cur.pos, 'next', { loop: !!nd.loop, shuffle: !!nd.shuffle });
        const directives: Directive[] = [clearEnqueued()];
        if (next) directives.push(playDirective(next.track, tokenFor(cur.queueId, next.item.pos), 0, 'ENQUEUE', token));
        return respond({ speech, directives, end: true });
      }
      return respond({ speech, end: true });
    }
    case 'WhatsPlayingIntent': {
      const cur = currentTrack(deviceId, token);
      if (!cur) return respond({ speech: t('nothingPlaying'), end: true });
      const { title, artist, album } = cur.track;
      return respond({ speech: t('nowPlaying', title, artist, album), end: true });
    }
    case 'AddToPlaylistIntent': {
      const cur = currentTrack(deviceId, token);
      const wanted = slot(intent, 'playlist');
      if (!cur) return respond({ speech: t('nothingPlaying'), end: true });
      if (!wanted) return respond({ speech: t('whichPlaylist'), reprompt: t('whichPlaylist'), end: false });
      const { id, name: plName, created } = findOrCreateUserPlaylist(wanted);
      const pos = get<{ n: number }>('SELECT COALESCE(MAX(position) + 1, 0) AS n FROM playlist_tracks WHERE playlist_id = ?', id)!.n;
      run('INSERT INTO playlist_tracks (playlist_id, position, track_id) VALUES (?, ?, ?)', id, pos, cur.track.id);
      return respond({ speech: t(created ? 'addedNewPlaylist' : 'addedToPlaylist', cur.track.title, plName), end: true });
    }
    case 'IgnoreTrackIntent': {
      const cur = currentTrack(deviceId, token);
      if (!cur) return respond({ speech: t('nothingPlaying'), end: true });
      run('UPDATE tracks SET hidden = 1 WHERE id = ?', cur.track.id);
      addMessage('library', 'info', `Pista ocultada por voz: ${cur.track.title}`, 'Puedes volver a mostrarla desde Biblioteca.');
      const next = navigate(cur.queueId, cur.pos, 'next', { loop: !!d.loop, shuffle: !!d.shuffle });
      if (!next) return respond({ speech: t('ignored'), directives: [stopDirective()], end: true });
      prepare(next.track);
      updateDevice(deviceId, { queue_id: cur.queueId, pos: next.item.pos, offset_ms: 0 });
      return respond({ speech: t('ignored'), directives: [playDirective(next.track, tokenFor(cur.queueId, next.item.pos), 0, 'REPLACE_ALL')], end: true });
    }
    case 'AMAZON.HelpIntent':
      return respond({ speech: t('help', settings().invocationName), reprompt: t('reprompt'), end: false });
    case 'AMAZON.FallbackIntent':
      return respond({ speech: t('fallback'), reprompt: t('reprompt'), end: false });
    case 'AMAZON.NavigateHomeIntent':
      return respond({ end: true });
    default:
      log.warn(`Unhandled intent ${name}`);
      return respond({ speech: t('fallback'), end: true });
  }
}

function findOrCreateUserPlaylist(wanted: string) {
  const lists = all<{ id: string; name: string }>("SELECT id, name FROM playlists WHERE kind = 'user'");
  const qn = norm(wanted);
  const hit = lists.find((p) => norm(p.name) === qn) ?? lists.find((p) => similarity(norm(p.name), qn) >= 0.75);
  if (hit) return { ...hit, created: false };
  const id = crypto.randomUUID();
  const name = wanted.charAt(0).toUpperCase() + wanted.slice(1);
  run("INSERT INTO playlists (id, name, kind, created_at) VALUES (?, ?, 'user', ?)", id, name, Date.now());
  return { id, name, created: true };
}

// ---------------------------------------------------------------- AudioPlayer & PlaybackController events

function handleAudioEvent(deviceId: string, req: any): Res {
  const type: string = req.type;
  const tok = parseToken(req.token);
  const offset = Number(req.offsetInMilliseconds ?? 0);
  const d = device(deviceId);
  if (!tok) return respond();
  const q = getQueue(tok.queueId);

  switch (type) {
    case 'AudioPlayer.PlaybackStarted': {
      updateDevice(deviceId, { queue_id: tok.queueId, pos: tok.pos === 'radio' ? 0 : tok.pos, offset_ms: offset, state: 'playing' });
      if (tok.pos === 'radio' || !q) return respond();
      const hit = itemAt(tok.queueId, tok.pos);
      if (hit) {
        run('UPDATE tracks SET play_count = play_count + 1, last_played = ? WHERE id = ?', Date.now(), hit.track.id);
        saveBookmark(LAST_BOOKMARK, hit.track.id, offset, tok.queueId);
        if (q.search_hash) saveBookmark(q.search_hash, hit.track.id, offset, tok.queueId);
        addMessage('streaming', 'info', `Sonando en ${d.name}: ${hit.track.title} — ${hit.track.artist}`, hit.track.path);
      }
      return respond();
    }
    case 'AudioPlayer.PlaybackNearlyFinished': {
      if (tok.pos === 'radio') return respond();
      const next = navigate(tok.queueId, tok.pos, 'next', { loop: !!d.loop, shuffle: !!d.shuffle });
      if (!next) return respond();
      prepare(next.track);
      return respond({ directives: [playDirective(next.track, tokenFor(tok.queueId, next.item.pos), 0, 'ENQUEUE', req.token)] });
    }
    case 'AudioPlayer.PlaybackFinished':
      updateDevice(deviceId, { state: 'idle', offset_ms: 0 });
      return respond();
    case 'AudioPlayer.PlaybackStopped': {
      updateDevice(deviceId, { queue_id: tok.queueId, pos: tok.pos === 'radio' ? 0 : tok.pos, offset_ms: offset, state: 'paused' });
      if (tok.pos !== 'radio' && q) {
        const hit = itemAt(tok.queueId, tok.pos);
        if (hit) {
          saveBookmark(LAST_BOOKMARK, hit.track.id, offset, tok.queueId);
          if (q.search_hash) saveBookmark(q.search_hash, hit.track.id, offset, tok.queueId);
        }
      }
      return respond();
    }
    case 'AudioPlayer.PlaybackFailed': {
      const hit = tok.pos !== 'radio' ? itemAt(tok.queueId, tok.pos) : undefined;
      const err = req.error ?? {};
      const transcodeHint = hit && hit.track.transcode !== 'none'
        ? `La pista (${hit.track.codec}) necesita transcodificación; comprueba que ffmpeg funciona en el contenedor.`
        : 'Si pasa con todas las pistas, comprueba que la URL pública (Tailscale Funnel) responde desde fuera de tu red.';
      addMessage('streaming', 'error', `Alexa no pudo reproducir ${hit?.track.title ?? 'la radio'}: ${err.type ?? 'error'}`,
        `${err.message ?? ''}\n\n${transcodeHint}${hit ? `\n\nArchivo: ${hit.track.path}` : ''}`);
      if (tok.pos === 'radio') return respond();
      const next = navigate(tok.queueId, tok.pos, 'next', { loop: false, shuffle: !!d.shuffle });
      if (!next) return respond();
      prepare(next.track);
      updateDevice(deviceId, { pos: next.item.pos, offset_ms: 0 });
      return respond({ directives: [playDirective(next.track, tokenFor(tok.queueId, next.item.pos), 0, 'REPLACE_ALL')] });
    }
    default:
      return respond();
  }
}

function handlePlaybackController(deviceId: string, req: any, ctx: any): Res {
  const token = ctx?.AudioPlayer?.token;
  let res: Res;
  switch (req.type) {
    case 'PlaybackController.NextCommandIssued': res = jump(deviceId, 'next', token); break;
    case 'PlaybackController.PreviousCommandIssued': res = jump(deviceId, 'previous', token); break;
    case 'PlaybackController.PlayCommandIssued': res = resumeDevice(deviceId, ctx?.AudioPlayer?.offsetInMilliseconds); break;
    case 'PlaybackController.PauseCommandIssued': res = respond({ directives: [stopDirective()] }); break;
    default: res = respond();
  }
  // Button presses may only answer with AudioPlayer directives: no speech, reprompt or session flags.
  const { outputSpeech, reprompt, shouldEndSession, ...rest } = res.response as any;
  return { version: '1.0', response: rest };
}

// ---------------------------------------------------------------- entry point

export function handleAlexa(envelope: any): Res {
  const req = envelope.request ?? {};
  const ctx = envelope.context ?? {};
  const deviceId: string = ctx.System?.device?.deviceId ?? 'unknown';
  const type: string = req.type ?? '';
  log.debug(`${type}${req.intent ? ' ' + req.intent.name : ''}`);

  if (!settings().publicUrl && (type === 'IntentRequest' || type.startsWith('AudioPlayer') || type.startsWith('PlaybackController'))) {
    return respond({ speech: t('noPublicUrl'), end: true });
  }

  try {
    if (type === 'LaunchRequest') {
      device(deviceId);
      return respond({ speech: t('welcome'), reprompt: t('reprompt'), end: false });
    }
    if (type === 'IntentRequest') return handleIntent(deviceId, req, ctx);
    if (type.startsWith('AudioPlayer.')) return handleAudioEvent(deviceId, req);
    if (type.startsWith('PlaybackController.')) return handlePlaybackController(deviceId, req, ctx);
    if (type === 'System.ExceptionEncountered') {
      log.error('Alexa reported an exception', JSON.stringify(req.error));
      addMessage('alexa', 'error', `Alexa informó un error: ${req.error?.type ?? ''}`, req.error?.message ?? '');
      return respond();
    }
    return respond(); // SessionEndedRequest and friends
  } catch (err) {
    log.error(`Failed handling ${type}`, err);
    return respond({ speech: t('internalError'), end: true });
  }
}
