import { BaseError, type BaseErrorOptions } from './base.js';
import { scrubSecrets } from './redact.js';

export type FreeloApiErrorCode =
  | 'AUTH_EXPIRED'
  | 'AUTH_MISSING'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'FREELO_API_ERROR'
  | 'VALIDATION_ERROR'
  | 'RATE_LIMITED'
  | 'SERVER_ERROR';

export type FreeloApiErrorOptions = BaseErrorOptions & {
  readonly errors?: string[];
  readonly rawBody?: unknown;
};

/**
 * Thrown for any HTTP error from the Freelo REST API.
 *
 * - 401 → `code: 'AUTH_EXPIRED'`, `exitCode: 3`, `retryable: false`
 * - 403 → `code: 'FORBIDDEN'`, `exitCode: 4`, `retryable: false`
 * - 429 (after budget) → use `RateLimitedError` instead
 * - 5xx → `code: 'FREELO_API_ERROR'`, `exitCode: 4`, `retryable: true`
 * - other 4xx → `code: 'FREELO_API_ERROR'`, `exitCode: 4`, `retryable: false`
 * - zod parse failure on 2xx → `code: 'VALIDATION_ERROR'`, `exitCode: 4`
 */
export class FreeloApiError extends BaseError {
  readonly code: FreeloApiErrorCode;
  readonly exitCode: number;
  readonly retryable: boolean;
  readonly errors: string[];
  readonly rawBody: unknown;

  constructor(message: string, code: FreeloApiErrorCode, options?: FreeloApiErrorOptions) {
    super(message, options);
    this.code = code;
    this.errors = options?.errors ?? [];
    this.rawBody = scrubSecrets(options?.rawBody);

    switch (code) {
      case 'AUTH_EXPIRED':
      case 'AUTH_MISSING':
        this.exitCode = 3;
        this.retryable = false;
        break;
      case 'SERVER_ERROR':
        this.exitCode = 4;
        this.retryable = true;
        break;
      default:
        this.exitCode = 4;
        this.retryable = false;
    }
  }

  /**
   * Build a `FreeloApiError` from a raw HTTP response. Normalizes the body's
   * `errors` field (handles both `string[]` and `Array<{message:string}>`).
   */
  static fromResponse({
    status,
    errors,
    rawBody,
    requestId,
    tokenPreviouslyWorked = false,
  }: {
    status: number;
    errors?: string[];
    rawBody?: unknown;
    requestId?: string;
    tokenPreviouslyWorked?: boolean;
  }): FreeloApiError {
    const base: FreeloApiErrorOptions = {
      httpStatus: status,
      ...(requestId !== undefined ? { requestId } : {}),
      ...(errors !== undefined ? { errors } : {}),
      ...(rawBody !== undefined ? { rawBody } : {}),
    };

    if (status === 401) {
      const hint = tokenPreviouslyWorked
        ? `Run \`freelo auth login\` to refresh.`
        : `Run \`freelo auth login\` to set up credentials.`;
      return new FreeloApiError(
        tokenPreviouslyWorked ? 'Stored token is no longer valid.' : 'Invalid credentials.',
        'AUTH_EXPIRED',
        { ...base, hintNext: hint },
      );
    }
    if (status >= 500) {
      return new FreeloApiError(`Freelo API server error (HTTP ${status}).`, 'SERVER_ERROR', base);
    }
    if (status === 403) {
      return new FreeloApiError(`Forbidden (HTTP 403).`, 'FORBIDDEN', base);
    }
    if (status === 404) {
      return new FreeloApiError(`Not found (HTTP 404).`, 'NOT_FOUND', base);
    }
    return new FreeloApiError(`Freelo API error (HTTP ${status}).`, 'FREELO_API_ERROR', base);
  }
}
