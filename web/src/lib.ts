import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

// ---------------------------------------------------------------- api

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const res = await fetch(path, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'),
    headers: opts.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    credentials: 'same-origin',
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Sesión caducada');
  }
  const text = await res.text();
  const data = text ? (() => { try { return JSON.parse(text); } catch { return text; } })() : undefined;
  if (!res.ok) throw new ApiError(res.status, (data as any)?.error ?? `Error ${res.status}`);
  return data as T;
}

/** Fetch + optional polling. `reload()` refetches immediately. */
export function useApi<T>(path: string | null, opts: { poll?: number } = {}) {
  const [data, setData] = useState<T | undefined>();
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    try {
      const d = await api<T>(path);
      if (n === seq.current) {
        setData(d);
        setError(undefined);
      }
    } catch (e) {
      if (n === seq.current) setError((e as Error).message);
    } finally {
      if (n === seq.current) setLoading(false);
    }
  }, [path]);
  useEffect(() => {
    setLoading(true);
    void load();
    if (!opts.poll) return;
    const id = setInterval(() => {
      if (document.visibilityState === 'visible') void load();
    }, opts.poll);
    return () => clearInterval(id);
  }, [load, opts.poll]);
  return { data, error, loading, reload: load, setData };
}

export function useDebounced<T>(value: T, ms = 250) {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

// ---------------------------------------------------------------- router (hash based: works behind any proxy)

function subscribe(cb: () => void) {
  window.addEventListener('hashchange', cb);
  return () => window.removeEventListener('hashchange', cb);
}
export function useRoute(): [string, URLSearchParams] {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash);
  const raw = hash.replace(/^#/, '') || '/';
  const [p, q] = raw.split('?');
  return [p, new URLSearchParams(q ?? '')];
}
export function navigate(to: string) {
  window.location.hash = to;
}

// ---------------------------------------------------------------- toasts

type Toast = { id: number; text: string; kind: 'ok' | 'error' };
let toasts: Toast[] = [];
const toastSubs = new Set<() => void>();
export function toast(text: string, kind: Toast['kind'] = 'ok') {
  const id = Date.now() + Math.random();
  toasts = [...toasts, { id, text, kind }];
  toastSubs.forEach((f) => f());
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== id);
    toastSubs.forEach((f) => f());
  }, 3200);
}
export function useToasts() {
  return useSyncExternalStore(
    (cb) => (toastSubs.add(cb), () => toastSubs.delete(cb)),
    () => toasts,
  );
}

/** Run an action, toast the outcome. */
export async function act<T>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    toast((e as Error).message, 'error');
    return undefined;
  }
}

// ---------------------------------------------------------------- formatting

export function fmtDuration(sec: number) {
  if (!sec || sec < 0) return '–';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

export function fmtHours(sec: number) {
  const h = sec / 3600;
  return h >= 100 ? `${Math.round(h)} h` : h >= 1 ? `${h.toFixed(1)} h` : `${Math.round(sec / 60)} min`;
}

const rtf = new Intl.RelativeTimeFormat('es', { numeric: 'auto' });
export function fmtAgo(ts: number) {
  if (!ts) return 'nunca';
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 45) return 'ahora mismo';
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(ts).toLocaleDateString('es');
}

export const nf = new Intl.NumberFormat('es');

/** Stable pleasant gradient from a string — fallback covers. */
export function gradientFor(s: string) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  const a = h % 360;
  const b = (a + 40 + (h >> 8) % 60) % 360;
  return `linear-gradient(135deg, hsl(${a} 55% 42%), hsl(${b} 60% 30%))`;
}

export function initials(s: string) {
  const words = s.replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).filter(Boolean);
  return (words.length > 1 ? words[0][0] + words[1][0] : (words[0] ?? '?').slice(0, 2)).toUpperCase();
}
