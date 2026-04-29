import { type Logger } from 'pino';
import { type ZodTypeAny, type z } from 'zod';
import { FreeloApiError } from '../errors/freelo-api-error.js';
import { NetworkError } from '../errors/network-error.js';
import { RateLimitedError } from '../errors/rate-limited-error.js';
import { FreeloErrorBodySchema, normalizeErrors } from './schemas/error.js';

export type RateLimit = {
  remaining: number | null;
  resetAt: string | null;
};

export type ApiResponse<T> = {
  data: T;
  rateLimit: RateLimit;
  requestId: string;
};

export type HttpClientOptions = {
  email: string;
  apiKey: string;
  apiBaseUrl: string;
  userAgent: string;
  logger?: Logger;
  /** Shared AbortSignal for SIGINT cancellation. */
  signal?: AbortSignal;
};

/**
 * Request options. `S` is the zod schema type; `T` is its inferred output
 * (post-transform). Using `z.input<S>` and `z.output<S>` separately lets
 * schemas with `.transform(...)` (e.g. `CurrencySchema` widening string|number
 * to canonical string) work without forcing input == output.
 */
export type RequestOptions<S extends ZodTypeAny> = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  body?: unknown;
  schema: S;
  signal?: AbortSignal;
  requestId?: string;
};

const GET_MAX_ATTEMPTS = 3;

function jitter(): number {
  return Math.floor(Math.random() * 500);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const n = Number(header);
  if (!Number.isNaN(n) && n >= 0) return n * 1000; // seconds → ms
  // HTTP-date form
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, date.getTime() - Date.now());
  }
  return null;
}

function extractRateLimit(headers: Headers): RateLimit {
  const remaining =
    headers.get('RateLimit-Remaining') ?? headers.get('X-RateLimit-Remaining') ?? null;
  const resetAt = headers.get('RateLimit-Reset') ?? headers.get('X-RateLimit-Reset') ?? null;
  return {
    remaining: remaining !== null ? Number(remaining) : null,
    resetAt,
  };
}

/**
 * Thin HTTP client for the Freelo REST API.
 *
 * Uses the global `fetch` (Node 18+ / undici-backed in Node 20).
 * MSW 2.x intercepts at the fetch level so tests work without any dispatcher
 * injection.
 */
export class HttpClient {
  readonly #email: string;
  readonly #apiKey: string;
  readonly #apiBaseUrl: string;
  readonly #userAgent: string;
  readonly #logger: Logger | undefined;
  readonly #signal: AbortSignal | undefined;

  constructor(opts: HttpClientOptions) {
    this.#email = opts.email;
    this.#apiKey = opts.apiKey;
    this.#apiBaseUrl = opts.apiBaseUrl.replace(/\/$/, '');
    this.#userAgent = opts.userAgent;
    this.#logger = opts.logger;
    this.#signal = opts.signal;
  }

  async request<S extends ZodTypeAny>(opts: RequestOptions<S>): Promise<ApiResponse<z.output<S>>> {
    const { method, path, body, schema } = opts;
    // Resolve optional fields to non-undefined for exactOptionalPropertyTypes.
    const requestId = opts.requestId;
    const signal = opts.signal ?? this.#signal;
    const url = `${this.#apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;
    const isWrite = method !== 'GET';

    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.#email}:${this.#apiKey}`).toString('base64')}`,
      'User-Agent': this.#userAgent,
      Accept: 'application/json',
    };
    if (requestId) headers['X-Request-Id'] = requestId;
    if (isWrite && body !== undefined) {
      headers['Content-Type'] = 'application/json; charset=utf-8';
    }

    const fetchInit: RequestInit = {
      method,
      headers,
    };
    if (body !== undefined) fetchInit.body = JSON.stringify(body);
    if (signal !== undefined) fetchInit.signal = signal;

    const attempt = async (attemptNum: number): Promise<ApiResponse<z.output<S>>> => {
      let response: Response;
      try {
        response = await fetch(url, fetchInit);
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          throw err; // Let abort propagate; top-level handler catches it.
        }
        throw new NetworkError(
          `Network error calling ${method} ${path}: ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        );
      }

      const rateLimit = extractRateLimit(response.headers);

      // 429 handling
      if (response.status === 429) {
        const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
        const retryAfterSec = retryAfterMs !== null ? retryAfterMs / 1000 : undefined;

        if (isWrite) {
          throw new RateLimitedError(`Rate limited on ${method} ${path}.`, {
            ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
            ...(requestId !== undefined ? { requestId } : {}),
          });
        }
        if (attemptNum >= GET_MAX_ATTEMPTS) {
          throw new RateLimitedError(
            `Rate limit budget exhausted on GET ${path} after ${GET_MAX_ATTEMPTS} attempts.`,
            {
              ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
              ...(requestId !== undefined ? { requestId } : {}),
            },
          );
        }
        const sleepMs = (retryAfterMs ?? 1000) + jitter();
        this.#logger?.warn(
          { attempt: attemptNum, sleepMs, requestId },
          `GET ${path} returned 429; retrying in ${sleepMs} ms`,
        );
        await sleep(sleepMs);
        return attempt(attemptNum + 1);
      }

      // 401
      if (response.status === 401) {
        let errors: string[] | undefined;
        try {
          const raw = await response.json();
          const parsed = FreeloErrorBodySchema.safeParse(raw);
          if (parsed.success) errors = normalizeErrors(parsed.data);
        } catch {
          // Ignore parse errors on error bodies.
        }
        throw FreeloApiError.fromResponse({
          status: 401,
          ...(errors !== undefined ? { errors } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        });
      }

      // Other error statuses
      if (!response.ok) {
        let errors: string[] | undefined;
        let rawBody: unknown;
        try {
          rawBody = await response.json();
          const parsed = FreeloErrorBodySchema.safeParse(rawBody);
          if (parsed.success) errors = normalizeErrors(parsed.data);
        } catch {
          // Ignore.
        }
        throw FreeloApiError.fromResponse({
          status: response.status,
          ...(errors !== undefined ? { errors } : {}),
          ...(rawBody !== undefined ? { rawBody } : {}),
          ...(requestId !== undefined ? { requestId } : {}),
        });
      }

      // 204 No Content — feed `null` to the schema (spec 0030 §2.5, R19).
      // First documented use is `GET /timetracking/status`; any future 204
      // endpoint inherits the same treatment. Pure addition — no existing
      // schema accepts `null`, so existing callers see no behavior change.
      if (response.status === 204) {
        const parsed = schema.safeParse(null);
        if (!parsed.success) {
          throw new FreeloApiError(
            `Unexpected 204 No Content from ${method} ${path}: ${parsed.error.message}`,
            'VALIDATION_ERROR',
            {
              ...(requestId !== undefined ? { requestId } : {}),
            },
          );
        }
        const data = parsed.data as z.output<S>;
        return { data, rateLimit, requestId: requestId ?? '' };
      }

      // 2xx — parse through schema
      let rawBody: unknown;
      try {
        rawBody = await response.json();
      } catch (err) {
        throw new FreeloApiError(
          `Failed to parse JSON response from ${method} ${path}.`,
          'FREELO_API_ERROR',
          {
            cause: err,
            ...(requestId !== undefined ? { requestId } : {}),
          },
        );
      }

      const parsed = schema.safeParse(rawBody);
      if (!parsed.success) {
        throw new FreeloApiError(
          `Unexpected response shape from ${method} ${path}: ${parsed.error.message}`,
          'VALIDATION_ERROR',
          {
            rawBody,
            ...(requestId !== undefined ? { requestId } : {}),
          },
        );
      }

      // parsed.data is z.output<S> by construction (safeParse on schema S).
      // ESLint flags it as `any` because the inner attempt closure widens T.
      const data = parsed.data as z.output<S>;
      return { data, rateLimit, requestId: requestId ?? '' };
    };

    return attempt(1);
  }

  /**
   * Multipart POST. Additive companion to `request()` — does NOT share its
   * code path. Built for `POST /file/upload` (R25, spec 0037 §5.2).
   *
   * Differences from `request()`:
   *   - Body is a `FormData` (not JSON-stringified). `fetch` automatically
   *     sets `Content-Type: multipart/form-data; boundary=…`.
   *   - No 429-retry. Writes never retry today; multipart writes inherit the
   *     same rule.
   *   - Method is fixed at POST. The Freelo API has no GET/PUT/PATCH/DELETE
   *     multipart endpoints.
   *
   * Shares with `request()`:
   *   - Authorization (Basic) and User-Agent headers.
   *   - 401 / 4xx / 5xx error path → `FreeloApiError.fromResponse`.
   *   - Network failure → `NetworkError`.
   *   - 429 → `RateLimitedError` (no retry).
   *   - 2xx → JSON parse → schema-validate.
   *   - Rate-limit header extraction.
   */
  async requestMultipart<S extends ZodTypeAny>(opts: {
    path: string;
    body: FormData;
    schema: S;
    signal?: AbortSignal;
    requestId?: string;
  }): Promise<ApiResponse<z.output<S>>> {
    const { path, body, schema } = opts;
    const requestId = opts.requestId;
    const signal = opts.signal ?? this.#signal;
    const url = `${this.#apiBaseUrl}${path.startsWith('/') ? path : `/${path}`}`;

    const headers: Record<string, string> = {
      Authorization: `Basic ${Buffer.from(`${this.#email}:${this.#apiKey}`).toString('base64')}`,
      'User-Agent': this.#userAgent,
      Accept: 'application/json',
    };
    if (requestId) headers['X-Request-Id'] = requestId;
    // NOTE: do NOT set Content-Type — fetch sets it (with boundary) when the
    // body is a FormData instance.

    // The undici FormData type and the global RequestInit['body'] type
    // overlap structurally but TypeScript can't prove it. Build the init
    // and cast through unknown so we don't depend on lib.dom typings.
    const fetchInit = {
      method: 'POST',
      headers,
      body,
    } as unknown as RequestInit;
    if (signal !== undefined) (fetchInit as { signal?: AbortSignal }).signal = signal;

    let response: Response;
    try {
      response = await fetch(url, fetchInit);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') {
        throw err;
      }
      throw new NetworkError(
        `Network error calling POST ${path}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      );
    }

    const rateLimit = extractRateLimit(response.headers);

    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
      const retryAfterSec = retryAfterMs !== null ? retryAfterMs / 1000 : undefined;
      throw new RateLimitedError(`Rate limited on POST ${path}.`, {
        ...(retryAfterSec !== undefined ? { retryAfterSec } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }

    if (response.status === 401) {
      let errors: string[] | undefined;
      try {
        const raw = await response.json();
        const parsed = FreeloErrorBodySchema.safeParse(raw);
        if (parsed.success) errors = normalizeErrors(parsed.data);
      } catch {
        // Ignore parse errors on error bodies.
      }
      throw FreeloApiError.fromResponse({
        status: 401,
        ...(errors !== undefined ? { errors } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }

    if (!response.ok) {
      let errors: string[] | undefined;
      let rawBody: unknown;
      try {
        rawBody = await response.json();
        const parsed = FreeloErrorBodySchema.safeParse(rawBody);
        if (parsed.success) errors = normalizeErrors(parsed.data);
      } catch {
        // Ignore.
      }
      throw FreeloApiError.fromResponse({
        status: response.status,
        ...(errors !== undefined ? { errors } : {}),
        ...(rawBody !== undefined ? { rawBody } : {}),
        ...(requestId !== undefined ? { requestId } : {}),
      });
    }

    let rawBody: unknown;
    try {
      rawBody = await response.json();
    } catch (err) {
      throw new FreeloApiError(
        `Failed to parse JSON response from POST ${path}.`,
        'FREELO_API_ERROR',
        {
          cause: err,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      );
    }

    const parsed = schema.safeParse(rawBody);
    if (!parsed.success) {
      throw new FreeloApiError(
        `Unexpected response shape from POST ${path}: ${parsed.error.message}`,
        'VALIDATION_ERROR',
        {
          rawBody,
          ...(requestId !== undefined ? { requestId } : {}),
        },
      );
    }

    const data = parsed.data as z.output<S>;
    return { data, rateLimit, requestId: requestId ?? '' };
  }
}

/** Factory function — preferred over `new HttpClient()` in command code. */
export function createHttpClient(opts: HttpClientOptions): HttpClient {
  return new HttpClient(opts);
}
