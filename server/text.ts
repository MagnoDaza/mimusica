// Text helpers shared by indexing and voice search.
import crypto from 'node:crypto';

const STOPWORDS = new Set([
  // English (what Alexa often transcribes for English titles)
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'by', 'for', 'if', 'in', 'into', 'is', 'it',
  'no', 'not', 'of', 'on', 'or', 'such', 'that', 'the', 'their', 'then', 'there', 'these',
  'they', 'this', 'to', 'was', 'will', 'with',
  // Spanish
  'el', 'la', 'los', 'las', 'un', 'una', 'unos', 'unas', 'de', 'del', 'y', 'e', 'o', 'u', 'al',
]);

/** Lowercase, strip accents and punctuation, collapse spaces. "Beyoncé & JAY-Z" -> "beyonce jay z" */
export function norm(input: string | null | undefined): string {
  if (!input) return '';
  return input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function tokens(normalized: string): string[] {
  if (!normalized) return [];
  const all = normalized.split(' ');
  const meaningful = all.filter((t) => !STOPWORDS.has(t));
  return meaningful.length ? meaningful : all;
}

export function wordCount(input: string | null | undefined): number {
  if (!input) return 0;
  return input.trim().split(/\s+/).filter(Boolean).length;
}

/** Damerau-Levenshtein (optimal string alignment) distance. */
export function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev2 = new Array<number>(b.length + 1).fill(0);
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1);
      }
      cur[j] = v;
    }
    for (let j = 0; j <= b.length; j++) prev2[j] = prev[j];
    [prev, cur] = [cur, prev];
  }
  return prev[b.length];
}

/** 0..1 similarity, 1 = identical. */
export function similarity(a: string, b: string): number {
  const max = Math.max(a.length, b.length);
  if (!max) return 1;
  return 1 - editDistance(a, b) / max;
}

/** "rock;  POP rock" -> ["Rock", "Pop Rock"] */
export function splitGenres(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[;\/]/)
    .map((g) => g.trim())
    .filter(Boolean)
    .map((g) => g.toLowerCase().replace(/(^|[\s-])(\p{L})/gu, (_, sep, ch) => sep + ch.toUpperCase()));
}

export function sha256(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}
