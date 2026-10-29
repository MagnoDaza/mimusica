import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { config } from './config.ts';
import { settings, updateSettings } from './settings.ts';
import { logger } from './log.ts';
import { registerApi } from './http/api.ts';
import { registerStreamRoutes } from './http/stream.ts';
import { verifyAlexaRequest } from './alexa/verify.ts';
import { handleAlexa } from './alexa/skill.ts';
import { requestScanAll, schedulePeriodicRescan, watchFolders } from './scanner.ts';
import { addMessage } from './messages.ts';
import { ffmpegAvailable } from './media.ts';

const log = logger('main');
const here = path.dirname(fileURLToPath(import.meta.url));
const webDist = path.resolve(here, '../web/dist');

function rawJson(app: FastifyInstance) {
  // Keep the exact bytes: Alexa signatures are computed over the raw body.
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => {
    (req as any).rawBody = body;
    try {
      done(null, body.length ? JSON.parse(body.toString('utf8')) : {});
    } catch (err) {
      done(err as Error, undefined);
    }
  });
}

function alexaRoute(app: FastifyInstance) {
  app.post('/alexa', async (req, reply) => {
    let envelope: any = req.body;
    if (!config.skipAlexaVerify) {
      try {
        envelope = await verifyAlexaRequest(req.headers as any, (req as any).rawBody ?? Buffer.from(''), settings().skillId);
      } catch (err) {
        log.warn(`Rejected Alexa request: ${(err as Error).message}`);
        return reply.code(400).send({ error: 'invalid request' });
      }
    }
    return handleAlexa(envelope);
  });
}

function health(app: FastifyInstance) {
  app.get('/health', async () => ({ ok: true, app: 'mi-musica' }));
}

/** Port exposed to the Internet through Tailscale Funnel: only what Alexa needs. */
async function startPublic() {
  const app = Fastify({ logger: false, trustProxy: true });
  rawJson(app);
  health(app);
  alexaRoute(app);
  registerStreamRoutes(app, { session: false });
  app.setNotFoundHandler((_req, reply) => reply.code(404).send());
  await app.listen({ port: config.publicPort, host: config.host });
  log.info(`Alexa endpoint listening on :${config.publicPort} (exponer con Tailscale Funnel)`);
}

/** Web console + API. Keep it on the LAN / tailnet. */
async function startConsole() {
  const app = Fastify({ logger: false, trustProxy: true, bodyLimit: 4 * 1024 * 1024 });
  rawJson(app);
  health(app);
  alexaRoute(app); // handy for local tests with ALEXA_SKIP_VERIFY=1
  registerStreamRoutes(app, { session: true });
  registerApi(app);
  if (fs.existsSync(webDist)) {
    await app.register(fastifyStatic, { root: webDist, wildcard: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    log.warn(`Web console not built (${webDist} missing). Run: npm run build:web`);
  }
  await app.listen({ port: config.port, host: config.host });
  log.info(`Consola web en http://localhost:${config.port}`);
}

async function main() {
  log.info(`Mi Música arrancando. Datos en ${config.dataDir}; música en ${config.mediaRoots.join(', ')}`);
  if (!(await ffmpegAvailable())) {
    addMessage('system', 'warning', 'ffmpeg no está disponible', 'Los formatos FLAC, WMA, OGG, WAV y algunos M4A no podrán reproducirse en Alexa.');
  }
  await startConsole();
  await startPublic();
  if (settings().firstRun) {
    addMessage('system', 'info', 'Bienvenido a Mi Música', 'Añade tu carpeta de música y sigue los pasos de la pestaña Alexa.');
    updateSettings({ firstRun: false });
  }
  requestScanAll();
  schedulePeriodicRescan();
  watchFolders();
}

main().catch((err) => {
  log.error('Fatal', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM'] as const) process.on(sig, () => process.exit(0));
