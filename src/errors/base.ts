// Root of the typed error hierarchy. Every domain-specific error
// (FreeloApiError, ConfigError, ValidationError, NetworkError,
// ConfirmationError, RateLimitedError) extends this. `handleTopLevelError`
// in `src/bin/freelo.ts` uses the structured fields to emit a
// `freelo.error/v1` envelope — see `.claude/docs/architecture.md` §Error
// envelope.

export type BaseErrorOptions = {
  readonly cause?: unknown;
  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly hintNext?: string;
};

export abstract class BaseError extends Error {
  abstract readonly code: string;
  abstract readonly exitCode: number;
  abstract readonly retryable: boolean;

  readonly httpStatus?: number;
  readonly requestId?: string;
  readonly hintNext?: string;

  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    if (options?.httpStatus !== undefined) this.httpStatus = options.httpStatus;
    if (options?.requestId !== undefined) this.requestId = options.requestId;
    if (options?.hintNext !== undefined) this.hintNext = options.hintNext;
  }
}
