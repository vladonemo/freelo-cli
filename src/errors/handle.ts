import { getGlobalDispatcher } from 'undici';
import { BaseError } from './base.js';
import { isAbortError } from './network-error.js';

type OutputMode = 'human' | 'json' | 'ndjson';

type ErrorEnvelope = {
  schema: 'freelo.error/v1';
  error: {
    code: string;
    message: string;
    errors?: string[];
    http_status: number | null;
    request_id: string | null;
    retryable: boolean;
    hint_next: string | null;
    docs_url: null;
  };
};

function buildErrorEnvelopeInternal(err: BaseError): ErrorEnvelope {
  const httpStatus =
    'httpStatus' in err && typeof err.httpStatus === 'number' ? err.httpStatus : null;
  const requestId = 'requestId' in err && typeof err.requestId === 'string' ? err.requestId : null;
  const errors =
    'errors' in err && Array.isArray(err.errors) ? (err.errors as string[]) : undefined;

  return {
    schema: 'freelo.error/v1',
    error: {
      code: err.code,
      message: err.message,
      ...(errors !== undefined && errors.length > 0 ? { errors } : {}),
      http_status: httpStatus,
      request_id: requestId,
      retryable: err.retryable,
      hint_next: err.hintNext ?? null,
      docs_url: null,
    },
  };
}

/**
 * Drain undici's global dispatcher (keep-alive socket pool) before exit.
 *
 * On Windows, calling `process.exit()` while undici still owns live sockets
 * can trip libuv's strict async-handle teardown:
 *
 *   Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 *     file src\\win\\async.c, line 76
 *
 * `.close()` waits for in-flight requests to finish and tears down the pool
 * cleanly. By the time we reach `handleTopLevelError` we have nothing in
 * flight (the error envelope has already been written), so this resolves
 * promptly. Best-effort: any failure is swallowed so it cannot mask the
 * original exit code.
 */
export async function drainDispatcher(): Promise<void> {
  try {
    await getGlobalDispatcher().close();
  } catch {
    // best-effort cleanup; never mask the original exit code
  }
}

/**
 * Top-level error handler. Called after `AppConfig` has been resolved so the
 * output `mode` is known. Maps any thrown value to an exit code and emits an
 * appropriate human message or `freelo.error/v1` envelope.
 *
 * Async because we must drain undici's keep-alive pool before exit (see
 * `drainDispatcher`). The returned promise never resolves — it always calls
 * `process.exit`.
 */
export async function handleTopLevelError(err: unknown, mode: OutputMode): Promise<never> {
  // SIGINT: abort-shaped error → exit 130 regardless of mode.
  if (isAbortError(err)) {
    await drainDispatcher();
    process.exit(130);
  }

  // Normalise to a BaseError.
  let typed: BaseError;
  if (err instanceof BaseError) {
    typed = err;
  } else {
    // Non-typed error — synthetic INTERNAL_ERROR.
    const message = err instanceof Error ? err.message : String(err);
    // Avoid circular import by building a minimal stand-in inline.
    const synthetic: BaseError = Object.assign(new Error(message) as unknown as BaseError, {
      name: 'InternalError',
      code: 'INTERNAL_ERROR',
      exitCode: 1,
      retryable: false,
      hintNext: undefined as string | undefined,
      httpStatus: undefined as number | undefined,
      requestId: undefined as string | undefined,
    });
    typed = synthetic;
  }

  if (mode === 'human') {
    const showStack = process.env['FREELO_DEBUG'] === '1' || process.env['FREELO_DEBUG'] === 'true';
    process.stderr.write(`freelo: ${typed.message}\n`);
    if (typed.hintNext) {
      process.stderr.write(`  hint: ${typed.hintNext}\n`);
    }
    if (showStack && typed instanceof Error && typed.stack) {
      process.stderr.write(`${typed.stack}\n`);
    }
  } else {
    const envelope = buildErrorEnvelopeInternal(typed);
    process.stderr.write(`${JSON.stringify(envelope)}\n`);
  }

  await drainDispatcher();
  process.exit(typed.exitCode);
}
