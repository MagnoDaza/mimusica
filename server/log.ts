type Level = 'debug' | 'info' | 'warn' | 'error';

let verbose = process.env.LOG_LEVEL === 'debug';

export function setVerbose(v: boolean) {
  verbose = v || process.env.LOG_LEVEL === 'debug';
}

function write(level: Level, scope: string, msg: string, extra?: unknown) {
  if (level === 'debug' && !verbose) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}`;
  const out = level === 'error' || level === 'warn' ? console.error : console.log;
  if (extra !== undefined) out(line, extra instanceof Error ? extra.stack ?? extra.message : extra);
  else out(line);
}

export function logger(scope: string) {
  return {
    debug: (msg: string, extra?: unknown) => write('debug', scope, msg, extra),
    info: (msg: string, extra?: unknown) => write('info', scope, msg, extra),
    warn: (msg: string, extra?: unknown) => write('warn', scope, msg, extra),
    error: (msg: string, extra?: unknown) => write('error', scope, msg, extra),
  };
}
