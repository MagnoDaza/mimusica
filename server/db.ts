import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { config } from './config.ts';

export const db = new DatabaseSync(path.join(config.dataDir, 'mimusica.db'));

db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS folders (
  id            TEXT PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,
  label         TEXT NOT NULL DEFAULT '',
  status        TEXT NOT NULL DEFAULT 'pending',   -- pending | scanning | ok | error
  track_count   INTEGER NOT NULL DEFAULT 0,
  playlist_count INTEGER NOT NULL DEFAULT 0,
  error_count   INTEGER NOT NULL DEFAULT 0,
  identified    INTEGER NOT NULL DEFAULT 0,
  progress      INTEGER NOT NULL DEFAULT 0,
  error_message TEXT NOT NULL DEFAULT '',
  last_scan     INTEGER NOT NULL DEFAULT 0,
  created_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS tracks (
  id           TEXT PRIMARY KEY,
  folder_id    TEXT NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  path         TEXT NOT NULL UNIQUE,
  checksum     TEXT NOT NULL,
  title        TEXT NOT NULL DEFAULT '',
  artist       TEXT NOT NULL DEFAULT '',
  album_artist TEXT NOT NULL DEFAULT '',
  album        TEXT NOT NULL DEFAULT '',
  genre        TEXT NOT NULL DEFAULT '',      -- ';' joined, title-cased
  composer     TEXT NOT NULL DEFAULT '',
  year         INTEGER NOT NULL DEFAULT 0,
  disc         INTEGER NOT NULL DEFAULT 0,
  track_no     INTEGER NOT NULL DEFAULT 0,
  track_total  INTEGER NOT NULL DEFAULT 0,
  codec        TEXT NOT NULL DEFAULT '',      -- human readable + quirk flags
  duration     INTEGER NOT NULL DEFAULT 0,    -- seconds
  transcode    TEXT NOT NULL DEFAULT 'none',  -- none | recode | repackage
  has_art      INTEGER NOT NULL DEFAULT 0,
  art_key      TEXT NOT NULL DEFAULT '',
  hidden       INTEGER NOT NULL DEFAULT 0,
  audiobook    INTEGER NOT NULL DEFAULT 0,
  play_count   INTEGER NOT NULL DEFAULT 0,
  last_played  INTEGER NOT NULL DEFAULT 0,
  indexed_at   INTEGER NOT NULL,
  title_n      TEXT NOT NULL DEFAULT '',
  artist_n     TEXT NOT NULL DEFAULT '',
  album_artist_n TEXT NOT NULL DEFAULT '',
  album_n      TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS tracks_album ON tracks(album_n, disc, track_no);
CREATE INDEX IF NOT EXISTS tracks_artist ON tracks(artist_n);
CREATE INDEX IF NOT EXISTS tracks_album_artist ON tracks(album_artist_n);
CREATE INDEX IF NOT EXISTS tracks_title ON tracks(title_n);
CREATE INDEX IF NOT EXISTS tracks_folder ON tracks(folder_id);

CREATE TABLE IF NOT EXISTS track_genres (
  track_id TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  genre    TEXT NOT NULL,
  genre_n  TEXT NOT NULL,
  PRIMARY KEY (track_id, genre_n)
);
CREATE INDEX IF NOT EXISTS track_genres_n ON track_genres(genre_n);

CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL DEFAULT 'user',   -- user | file | webstream
  source_path TEXT NOT NULL DEFAULT '',
  stream_url  TEXT NOT NULL DEFAULT '',
  folder_id   TEXT REFERENCES folders(id) ON DELETE CASCADE,
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  PRIMARY KEY (playlist_id, position)
);

-- Play queues: what Alexa is walking through. Persisted so playback survives restarts.
CREATE TABLE IF NOT EXISTS queues (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  audiobook   INTEGER NOT NULL DEFAULT 0,
  search_hash TEXT NOT NULL DEFAULT '',
  stream_url  TEXT NOT NULL DEFAULT '',     -- set for web radio queues
  created_at  INTEGER NOT NULL,
  last_used   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS queue_items (
  queue_id   TEXT NOT NULL REFERENCES queues(id) ON DELETE CASCADE,
  pos        INTEGER NOT NULL,
  rand_order INTEGER NOT NULL,
  track_id   TEXT NOT NULL,
  PRIMARY KEY (queue_id, pos)
);

CREATE TABLE IF NOT EXISTS bookmarks (
  search_hash TEXT PRIMARY KEY,
  track_id    TEXT NOT NULL,
  offset_ms   INTEGER NOT NULL DEFAULT 0,
  queue_id    TEXT NOT NULL DEFAULT '',
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS devices (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL DEFAULT '',
  last_seen   INTEGER NOT NULL,
  queue_id    TEXT NOT NULL DEFAULT '',
  pos         INTEGER NOT NULL DEFAULT -1,
  offset_ms   INTEGER NOT NULL DEFAULT 0,
  state       TEXT NOT NULL DEFAULT 'idle',   -- idle | playing | paused | stopped
  shuffle     INTEGER NOT NULL DEFAULT 0,
  loop        INTEGER NOT NULL DEFAULT 0,
  updated_at  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS learnings (
  id                 TEXT PRIMARY KEY,
  criteria_album     TEXT, criteria_artist TEXT, criteria_genre TEXT,
  criteria_song      TEXT, criteria_playlist TEXT, criteria_book TEXT, criteria_query TEXT,
  trained_album      TEXT, trained_artist TEXT, trained_genre TEXT,
  trained_song       TEXT, trained_playlist TEXT, trained_book TEXT,
  created_at         INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS history (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  ts                INTEGER NOT NULL,
  device_id         TEXT NOT NULL DEFAULT '',
  utterance         TEXT NOT NULL DEFAULT '',
  criteria          TEXT NOT NULL,   -- JSON {album, artist, genre, song, playlist, book, everything}
  found             TEXT NOT NULL,   -- JSON
  trained           TEXT NOT NULL,   -- JSON
  learning_id       TEXT NOT NULL DEFAULT '',
  success           INTEGER NOT NULL,
  track_count       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS messages (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  context     TEXT NOT NULL,     -- library | streaming | alexa | system
  level       TEXT NOT NULL,     -- info | warning | error
  title       TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`);

type Row = Record<string, any>;

export function all<T = Row>(sql: string, ...params: any[]): T[] {
  return db.prepare(sql).all(...params) as T[];
}

export function get<T = Row>(sql: string, ...params: any[]): T | undefined {
  return db.prepare(sql).get(...params) as T | undefined;
}

export function run(sql: string, ...params: any[]) {
  return db.prepare(sql).run(...params);
}

export function tx<T>(fn: () => T): T {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
