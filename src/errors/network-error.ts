import { BaseError, type BaseErrorOptions } from './base.js';

/**
 * Thrown when a network-level failure prevents the request from completing:
 * DNS failure, connection refused, socket timeout, or an `AbortError` from
 * SIGINT cancellation.
 *
 * Exit code 5. Retryable (caller decides whether to retry; the HTTP client
 * uses this for the SIGINT abort path, which should not be retried by the
 * client but may be retried by the operator).
 */
export class NetworkError extends BaseError {
  readonly code = 'NETWORK_ERROR' as const;
  readonly exitCode = 5;
  readonly retryable = true;

  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options);
  }
}

/**
 * Return `true` when the error (or its `cause`) looks like an AbortError,
 * indicating the request was cancelled by an `AbortController` (i.e. SIGINT).
 * The top-level handler uses this to exit 130 instead of 5.
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err instanceof NetworkError) {
    const cause = (err as { cause?: unknown }).cause;
    if (cause instanceof Error && cause.name === 'AbortError') return true;
  }
  return false;
}
