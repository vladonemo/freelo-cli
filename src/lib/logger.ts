import { pino } from 'pino';
import { type ResolvedOutputMode } from './env.js';

export type LoggerOptions = {
  /** 0 = silent, 1 = info, 2 = debug */
  verbose: 0 | 1 | 2;
  mode: ResolvedOutputMode;
  requestId?: string;
  profile?: string;
};

const LEVEL_MAP = {
  0: 'silent',
  1: 'info',
  2: 'debug',
} as const;

/**
 * Keys that may carry secrets. Shared with `scrubSecrets` in `src/errors/redact.ts`.
 * Duplicated here so the logger serializer has no dependency on the errors layer.
 */
const SECRET_KEYS = new Set(['authorization', 'email', 'password', 'api_key', 'apikey', 'token']);

function redactValue(obj: unknown): unknown {
  if (Array.isArray(obj)) return obj.map(redactValue);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : redactValue(v);
    }
    return result;
  }
  return obj;
}

/**
 * Create a pino logger instance.
 *
 * - Default level: `silent` (verbose 0)
 * - `-v` → `info`, `-vv` / `FREELO_DEBUG=1` → `debug`
 * - In `human` mode on a TTY, lazily loads `pino-pretty` and attaches it as
 *   the transport. All other modes emit raw JSON lines to stderr.
 * - The serializer redacts secret keys at any depth before emission.
 */
export async function createLogger(opts: LoggerOptions): Promise<pino.Logger> {
  const level = LEVEL_MAP[opts.verbose];

  const serializers: pino.LoggerOptions['serializers'] = {
    req: (val: unknown) => redactValue(val),
    res: (val: unknown) => redactValue(val),
    // Redact arbitrary logged objects too
    obj: (val: unknown) => redactValue(val),
  };

  const baseBindings: Record<string, string> = {};
  if (opts.requestId) baseBindings['request_id'] = opts.requestId;
  if (opts.profile) baseBindings['profile'] = opts.profile;

  const isHumanTTY = opts.mode === 'human' && Boolean(process.stdout.isTTY);

  if (isHumanTTY && level !== 'silent') {
    // Lazy-load pino-pretty only when a human is watching.
    const pinoPretty = await import('pino-pretty');
    const transport = pinoPretty.build({
      colorize: true,
      destination: process.stderr.fd,
      sync: false,
    });
    const logger = pino({ level, serializers }, transport);
    return Object.keys(baseBindings).length > 0 ? logger.child(baseBindings) : logger;
  }

  const logger = pino(
    {
      level,
      serializers,
    },
    pino.destination({ dest: process.stderr.fd, sync: false }),
  );
  return Object.keys(baseBindings).length > 0 ? logger.child(baseBindings) : logger;
}
