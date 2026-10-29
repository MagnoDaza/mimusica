import path from 'node:path';
import fs from 'node:fs';

const env = process.env;

const dataDir = path.resolve(env.DATA_DIR ?? './data');
fs.mkdirSync(dataDir, { recursive: true });

export const config = {
  // Web console (LAN / tailnet only).
  port: Number(env.PORT ?? 8080),
  // Alexa endpoint + streams; the only port published with Tailscale Funnel.
  publicPort: Number(env.PUBLIC_PORT ?? 8081),
  host: env.HOST ?? '0.0.0.0',
  dataDir,
  // Roots the folder picker may browse. In Docker: /music (read-only mount).
  mediaRoots: (env.MEDIA_ROOTS ?? '/music')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean),
  ffmpeg: env.FFMPEG_PATH ?? 'ffmpeg',
  // Public HTTPS base URL (Tailscale Funnel). Can also be set from the web console.
  publicUrl: (env.PUBLIC_URL ?? '').replace(/\/+$/, ''),
  // Disable Alexa signature verification only for local testing.
  skipAlexaVerify: env.ALEXA_SKIP_VERIFY === '1',
  cacheDir: path.join(dataDir, 'cache'),
  logDir: path.join(dataDir, 'logs'),
};

fs.mkdirSync(config.cacheDir, { recursive: true });
fs.mkdirSync(config.logDir, { recursive: true });
