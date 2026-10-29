import type { FastifyReply, FastifyRequest } from 'fastify';
import { settings, sign } from '../settings.ts';

const COOKIE = 'mm_session';

function sessionValue() {
  // Rotates automatically when the password changes.
  return sign(`session:${settings().passwordHash}`);
}

function readCookie(req: FastifyRequest, name: string) {
  const raw = req.headers.cookie ?? '';
  for (const part of raw.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function isAuthed(req: FastifyRequest) {
  if (!settings().requirePassword || !settings().passwordHash) return true;
  return readCookie(req, COOKIE) === sessionValue();
}

export function setSessionCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${COOKIE}=${encodeURIComponent(sessionValue())}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000`);
}

export function clearSessionCookie(reply: FastifyReply) {
  reply.header('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}
