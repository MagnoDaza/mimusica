import fs from 'node:fs/promises';
import path from 'node:path';

export const PLAYLIST_EXTENSIONS = new Set(['.m3u', '.m3u8', '.pls', '.wpl']);

/** Returns the raw entries (paths or URLs) listed in a playlist file, in order. */
export async function readPlaylistFile(file: string): Promise<string[]> {
  const ext = path.extname(file).toLowerCase();
  const buf = await fs.readFile(file);
  // m3u (not m3u8) is often Latin-1; fall back when UTF-8 decoding yields replacement chars.
  let text = buf.toString('utf8');
  if (ext === '.m3u' && text.includes('�')) text = buf.toString('latin1');
  text = text.replace(/^﻿/, '');

  if (ext === '.pls') {
    return text
      .split(/\r?\n/)
      .map((l) => /^File\d+\s*=\s*(.+)$/i.exec(l.trim())?.[1])
      .filter((v): v is string => !!v);
  }
  if (ext === '.wpl') {
    const out: string[] = [];
    for (const m of text.matchAll(/<media\s+[^>]*src\s*=\s*"([^"]+)"/gi)) out.push(decodeXml(m[1]));
    return out;
  }
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

function decodeXml(s: string) {
  return s
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

export function isUrl(entry: string) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(entry);
}

/** Resolve an entry relative to the playlist; Windows paths become POSIX-ish for suffix matching. */
export function resolveEntry(playlistFile: string, entry: string): string {
  let e = entry.replace(/^file:\/\//i, '');
  try {
    e = decodeURI(e);
  } catch {}
  e = e.replace(/\\/g, '/');
  if (/^[a-z]:\//i.test(e) || e.startsWith('/')) return e;
  return path.posix.normalize(path.posix.join(path.dirname(playlistFile).replace(/\\/g, '/'), e));
}

export function m3uExport(name: string, rows: { path: string; title: string; artist: string; duration: number }[]) {
  const lines = ['#EXTM3U', `#PLAYLIST:${name}`];
  for (const r of rows) {
    lines.push(`#EXTINF:${r.duration || -1},${r.artist ? r.artist + ' - ' : ''}${r.title}`);
    lines.push(r.path);
  }
  return lines.join('\n') + '\n';
}
