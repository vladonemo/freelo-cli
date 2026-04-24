import { BaseError, type BaseErrorOptions } from './base.js';

export type RateLimitedErrorOptions = BaseErrorOptions & {
  readonly retryAfterSec?: number;
};

/**
 * Thrown when rate-limit budget is exhausted:
 * - Writes: immediately on 429 (no retry on writes).
 * - GETs: after N=3 attempts all returning 429.
 *
 * Exit code 6. Retryable (the operator / caller can wait and retry).
 */
export class RateLimitedError extends BaseError {
  readonly code = 'RATE_LIMITED' as const;
  readonly exitCode = 6;
  readonly retryable = true;
  readonly retryAfterSec?: number;

  constructor(message: string, options?: RateLimitedErrorOptions) {
    super(message, options);
    if (options?.retryAfterSec !== undefined) this.retryAfterSec = options.retryAfterSec;
  }
}
