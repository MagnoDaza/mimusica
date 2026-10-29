import crypto from 'node:crypto';
import { all, run } from './db.ts';
import { config } from './config.ts';
import { setVerbose } from './log.ts';

export type Settings = {
  /** Index & transcode FLAC/WMA/WAV/AIFF/OGG/OPUS ("Additional file formats"). */
  extraFormats: boolean;
  transcodeBitrate: number;
  replayGain: boolean;
  audiobookGenres: string[];
  /** Folders containing one of these files are skipped. */
  scanIgnoreFiles: string;
  /** Periodic rescan, hours (0 = off). */
  rescanHours: number;
  /** Played when the request has no criteria ("Alexa, pide a … que ponga música"). */
  defaultPlaylist: string;
  defaultPlaylistShuffle: boolean;
  sendAlbumArt: boolean;
  verboseLogging: boolean;
  autoImportPlaylists: boolean;
  /** Public HTTPS URL (Tailscale Funnel), e.g. https://nas.tu-tailnet.ts.net */
  publicUrl: string;
  /** amzn1.ask.skill.… — requests from other skills are rejected. Empty = accept any. */
  skillId: string;
  invocationName: string;
  locale: string;
  requirePassword: boolean;
  passwordHash: string;
  secret: string;
  firstRun: boolean;
};

const defaults: Settings = {
  extraFormats: true,
  transcodeBitrate: 192,
  replayGain: false,
  audiobookGenres: ['Audiobook', 'Audio book', 'Audiolibro', 'Comedy', 'Radio Drama'],
  scanIgnoreFiles: '.mmaignore,.nomedia',
  rescanHours: 6,
  defaultPlaylist: '',
  defaultPlaylistShuffle: true,
  sendAlbumArt: true,
  verboseLogging: false,
  autoImportPlaylists: true,
  publicUrl: config.publicUrl,
  skillId: process.env.ALEXA_SKILL_ID ?? '',
  invocationName: 'mi biblioteca',
  locale: 'es-ES',
  requirePassword: false,
  passwordHash: '',
  secret: '',
  firstRun: true,
};

let current: Settings = load();

function load(): Settings {
  const s: any = { ...defaults };
  for (const row of all<{ key: string; value: string }>('SELECT key, value FROM settings')) {
    if (row.key in defaults) s[row.key] = JSON.parse(row.value);
  }
  if (!s.secret) {
    s.secret = crypto.randomBytes(32).toString('hex');
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'secret', JSON.stringify(s.secret));
  }
  // Env vars win over stored values so the compose file stays the source of truth.
  if (config.publicUrl) s.publicUrl = config.publicUrl;
  if (process.env.ALEXA_SKILL_ID) s.skillId = process.env.ALEXA_SKILL_ID;
  setVerbose(s.verboseLogging);
  return s;
}

export function settings(): Settings {
  return current;
}

export function updateSettings(patch: Partial<Settings>) {
  const next: any = { ...current };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in defaults) || k === 'secret' || k === 'passwordHash') continue;
    next[k] = v;
  }
  if (typeof next.publicUrl === 'string') next.publicUrl = next.publicUrl.trim().replace(/\/+$/, '');
  next.transcodeBitrate = Math.min(320, Math.max(64, Number(next.transcodeBitrate) || 192));
  next.rescanHours = Math.max(0, Number(next.rescanHours) || 0);
  for (const [k, v] of Object.entries(next)) {
    run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', k, JSON.stringify(v));
  }
  current = next;
  setVerbose(current.verboseLogging);
  return current;
}

export function setPassword(password: string) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = password ? `${salt}:${crypto.scryptSync(password, salt, 32).toString('hex')}` : '';
  run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', 'passwordHash', JSON.stringify(hash));
  current = { ...current, passwordHash: hash };
  updateSettings({ requirePassword: !!password });
}

export function checkPassword(password: string): boolean {
  if (!current.passwordHash) return true;
  const [salt, hash] = current.passwordHash.split(':');
  const candidate = crypto.scryptSync(password, salt, 32);
  return crypto.timingSafeEqual(candidate, Buffer.from(hash, 'hex'));
}

/** Public view: never leaks secrets. */
export function publicSettings() {
  const { secret, passwordHash, ...rest } = current;
  return { ...rest, hasPassword: !!passwordHash };
}

/** HMAC for signed URLs (stream / art) handed to Alexa. */
export function sign(value: string): string {
  return crypto.createHmac('sha256', current.secret).update(value).digest('base64url').slice(0, 22);
}

export function verifySigned(value: string, sig: string | undefined): boolean {
  if (!sig) return false;
  const expected = Buffer.from(sign(value));
  const got = Buffer.from(sig);
  return expected.length === got.length && crypto.timingSafeEqual(expected, got);
}
