// Generates a small fake library (silent MP3s with real ID3v2.3 tags) for local testing.
// Usage: node scripts/make-test-library.ts ./testdata/music
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? './testdata/music');

function frame(id: string, text: string) {
  const body = Buffer.concat([Buffer.from([0x01, 0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  const h = Buffer.alloc(10);
  h.write(id, 0, 'latin1');
  h.writeUInt32BE(body.length, 4);
  return Buffer.concat([h, body]);
}

function id3(tags: Record<string, string>) {
  const frames = Buffer.concat(Object.entries(tags).filter(([, v]) => v).map(([k, v]) => frame(k, v)));
  const size = frames.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  return Buffer.concat([header, frames]);
}

// MPEG-1 Layer III, 128 kbps, 44.1 kHz: 417-byte frames; all-zero side info decodes as silence.
function silence(seconds: number) {
  const frameBuf = Buffer.alloc(417);
  frameBuf.set([0xff, 0xfb, 0x90, 0x64]);
  return Buffer.concat(Array.from({ length: Math.round(seconds * 38.28) }, () => frameBuf));
}

type T = { artist: string; album: string; title: string; genre: string; track: number; year?: number };
const lib: T[] = [
  { artist: 'Queen', album: 'A Night at the Opera', title: 'Bohemian Rhapsody', genre: 'Rock', track: 11, year: 1975 },
  { artist: 'Queen', album: 'A Night at the Opera', title: 'Love of My Life', genre: 'Rock', track: 9, year: 1975 },
  { artist: 'Queen', album: 'News of the World', title: 'We Will Rock You', genre: 'Rock', track: 1, year: 1977 },
  { artist: 'Soda Stereo', album: 'Canción Animal', title: 'De Música Ligera', genre: 'Rock en Español', track: 5, year: 1990 },
  { artist: 'Soda Stereo', album: 'Canción Animal', title: 'Canción Animal', genre: 'Rock en Español', track: 1, year: 1990 },
  { artist: 'AC/DC', album: 'Back in Black', title: 'Back in Black', genre: 'Hard Rock', track: 6, year: 1980 },
  { artist: 'AC/DC', album: 'Back in Black', title: 'Hells Bells', genre: 'Hard Rock', track: 1, year: 1980 },
  { artist: 'Beyoncé', album: 'Lemonade', title: 'Formation', genre: 'R&B', track: 12, year: 2016 },
  { artist: 'Shakira', album: 'Pies Descalzos', title: 'Estoy Aquí', genre: 'Pop Latino', track: 2, year: 1995 },
  { artist: 'Shakira', album: 'Pies Descalzos', title: 'Antología', genre: 'Pop Latino', track: 1, year: 1995 },
  { artist: 'Juan Luis Guerra', album: 'Bachata Rosa', title: 'Burbujas de Amor', genre: 'Bachata;Merengue', track: 3, year: 1990 },
];
const book = Array.from({ length: 3 }, (_, i) => ({
  artist: 'Antoine de Saint-Exupéry', album: 'El Principito', title: `Capítulo ${i + 1}`, genre: 'Audiolibro', track: i + 1,
}));

const safe = (s: string) => s.replace(/[\/\\:*?"<>|]/g, '_');
fs.rmSync(root, { recursive: true, force: true });
const written: string[] = [];
for (const t of [...lib, ...book]) {
  const dir = path.join(root, safe(t.artist), safe(t.album));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${String(t.track).padStart(2, '0')} ${safe(t.title)}.mp3`);
  fs.writeFileSync(file, Buffer.concat([
    id3({ TIT2: t.title, TPE1: t.artist, TPE2: t.artist, TALB: t.album, TCON: t.genre, TRCK: String(t.track), TYER: String((t as any).year ?? '') }),
    silence(8),
  ]));
  written.push(file);
}
// A playlist with relative paths, and an ignored folder.
fs.writeFileSync(path.join(root, 'Favoritas.m3u'), ['#EXTM3U', ...written.slice(0, 4).map((f) => path.relative(root, f).replace(/\\/g, '/'))].join('\n'));
fs.mkdirSync(path.join(root, 'Privado'), { recursive: true });
fs.writeFileSync(path.join(root, 'Privado', '.mmaignore'), '');
fs.copyFileSync(written[0], path.join(root, 'Privado', 'secreto.mp3'));
console.log(`Wrote ${written.length + 1} tracks to ${root}`);
