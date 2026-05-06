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
 * Round-2 fix (spec 0015 §3, R05.5): the prior `.close()` (graceful) was
 * insufficient on Windows — the assertion still fires on any zod-validation
 * failure exit. We now use `.destroy()` (forceful) bounded by a short
 * timeout race. Forceful is fine on the error path: by the time we run
 * here the error envelope has already been written and we have nothing
 * worth saving in flight.
 *
 * Best-effort: any failure is swallowed so it cannot mask the original
 * exit code.
 */
const DRAIN_TIMEOUT_MS = 250;

export async function drainDispatcher(): Promise<void> {
  try {
    const dispatcher = getGlobalDispatcher();
    const destroyPromise = dispatcher.destroy();
    const timeoutPromise = new Promise<void>((resolve) => {
      const t = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      // Do not keep the loop alive solely for this timer.
      t.unref?.();
    });
    await Promise.race([destroyPromise, timeoutPromise]);
  } catch {
    // best-effort cleanup; never mask the original exit code
  }
}

/**
 * Resolve the fallback delay before forcing `process.exit`. See
 * `exitDeferred` for the full rationale. 200ms beats the ~100ms threshold
 * empirically observed on Windows 11 + Node 24 with margin to spare;
 * macOS/Linux pay the same delay on the error path but never crash without
 * it.
 *
 * Read on each call (not at module init) so the test setup can override
 * via `FREELO_EXIT_DELAY_MS=0` regardless of import order with vitest's
 * setup files.
 */
function fallbackExitMs(): number {
  const raw = process.env['FREELO_EXIT_DELAY_MS'];
  if (raw === undefined) return 200;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

/**
 * Set `process.exitCode` and schedule a fallback `process.exit(code)` after
 * a short delay, then await it.
 *
 * Why a delay-based fallback rather than a phase-based one:
 *
 *   - `dispatcher.destroy()` initiates socket close but libuv has internal
 *     async handles (DNS thread-pool tasks, TLS Schannel finalization,
 *     ...) whose close callbacks are not surfaced via `_getActiveHandles`
 *     and don't all finalize within a fixed number of loop iterations.
 *   - Empirically (Win11 + Node 24), `process.exit` fires its libuv-walk
 *     teardown synchronously and asserts when any handle is still in
 *     `UV_HANDLE_CLOSING`:
 *
 *       Assertion failed: !(handle->flags & UV_HANDLE_CLOSING),
 *         file src\\win\\async.c, line 76
 *
 *   - 50× `setImmediate` hops do not clear it. ~100ms wall-clock does.
 *     Prior R05.5 fixes (graceful close → `.destroy()` → `setImmediate`)
 *     all fell short for this reason.
 *
 * The fix:
 *   1. `process.exitCode = code` — if the loop drains naturally during
 *      the fallback window (the normal case after `dispatcher.destroy()`
 *      and a flushed stderr write), the process exits cleanly with the
 *      right code and `process.exit` never fires.
 *   2. Otherwise, after `FALLBACK_EXIT_MS`, force-exit. By then libuv has
 *      finalized its internal async handles and the assertion no longer
 *      fires.
 *
 * Tests stub `process.exit` to throw; the `setTimeout` callback's throw
 * propagates into the awaited promise's rejection, so existing
 * `await expect(handleTopLevelError(...)).rejects.toThrow()` assertions
 * keep working. `FREELO_EXIT_DELAY_MS=0` in the test setup makes them
 * fire on the next tick instead of after 200ms.
 */
export function exitDeferred(code: number): Promise<never> {
  process.exitCode = code;
  return new Promise<never>((_resolve, reject) => {
    setTimeout(() => {
      try {
        process.exit(code);
      } catch (err) {
        reject(err as Error);
      }
    }, fallbackExitMs());
  });
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
    return exitDeferred(130);
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
  return exitDeferred(typed.exitCode);
}
