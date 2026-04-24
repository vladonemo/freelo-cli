import { type BaseError } from '../errors/base.js';

/**
 * Schema string format: `freelo.<resource>.<op>/v<n>`.
 * Registered in R01: freelo.auth.login/v1, freelo.auth.logout/v1,
 * freelo.auth.whoami/v1, freelo.error/v1.
 */
export type SchemaString = `freelo.${string}/v${number}`;

export type RateLimit = {
  remaining: number | null;
  reset_at: string | null;
};

export type Paging = {
  page: number;
  per_page: number;
  total: number;
  next_cursor: number | null;
};

/**
 * Standard success envelope. Every command that returns data uses this.
 * Field order is insertion-order; tests assert presence, not order.
 */
export type Envelope<T> = {
  schema: SchemaString;
  data: T;
  paging?: Paging;
  rate_limit?: RateLimit;
  request_id?: string;
  dry_run?: true;
  would?: unknown;
  notice?: string;
};

export type ErrorEnvelopePayload = {
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

export type BuildEnvelopeOptions<T> = {
  schema: SchemaString;
  data: T;
  rateLimit?: RateLimit;
  paging?: Paging;
  requestId?: string;
  notice?: string;
};

/** Build a standard success envelope. */
export function buildEnvelope<T>(opts: BuildEnvelopeOptions<T>): Envelope<T> {
  const env: Envelope<T> = {
    schema: opts.schema,
    data: opts.data,
  };
  if (opts.rateLimit !== undefined) env.rate_limit = opts.rateLimit;
  if (opts.paging !== undefined) env.paging = opts.paging;
  if (opts.requestId !== undefined) env.request_id = opts.requestId;
  if (opts.notice !== undefined) env.notice = opts.notice;
  return env;
}

/** Build a `freelo.error/v1` error envelope from a `BaseError`. */
export function buildErrorEnvelope(err: BaseError): ErrorEnvelopePayload {
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
