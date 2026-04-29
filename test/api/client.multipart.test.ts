/**
 * Tests for `HttpClient.requestMultipart` — the multipart POST companion to
 * `request()` added in R25 (spec 0037 §5.2, src/api/client.ts).
 *
 * Modelled after `test/api/client.retry.test.ts` and `test/api/client.204.test.ts`.
 * Exercises every branch that `request()` tests cover for `requestMultipart`:
 *
 *   - 200 happy path → parsed data + rate-limit headers
 *   - 200 JSON parse failure → FreeloApiError
 *   - 200 schema validation failure → FreeloApiError VALIDATION_ERROR
 *   - 401 with parseable body → FreeloApiError AUTH_EXPIRED, errors set
 *   - 401 with unparseable body → FreeloApiError AUTH_EXPIRED, no errors
 *   - 4xx / 5xx with parseable body → FreeloApiError, errors set
 *   - 4xx / 5xx with unparseable body → FreeloApiError, no errors field
 *   - 429 with Retry-After numeric header → RateLimitedError with retryAfterSec
 *   - 429 without Retry-After → RateLimitedError with retryAfterSec undefined
 *   - Network failure → NetworkError
 *   - AbortError propagated as-is (not wrapped)
 *   - signal from opts threads through
 *   - signal from constructor threads through
 *   - requestId set → X-Request-Id header + requestId in response
 *   - requestId unset → response.requestId is ''
 *   - rate-limit headers extracted correctly
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { server, API_BASE } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { RateLimitedError } from '../../src/errors/rate-limited-error.js';
import { VERSION } from '../../src/lib/version.js';

const UPLOAD_PATH = '/file/upload';
const UPLOAD_URL = `${API_BASE}${UPLOAD_PATH}`;

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/vladonemo/freelo-cli)`,
};

const UuidSchema = z.object({ uuid: z.string().min(1) });

function makeClient(overrides?: Partial<typeof TEST_OPTS>) {
  return new HttpClient({ ...TEST_OPTS, ...overrides });
}

function makeFormData(): FormData {
  const fd = new FormData();
  fd.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');
  return fd;
}

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

/* ---------------------------------------------------------------------------
 *  Happy path
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — 200 happy path', () => {
  it('returns parsed data matching the schema', async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json({ uuid: 'aaaa0000-0000-0000-0000-000000000001' }),
      ),
    );
    const client = makeClient();
    const result = await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
    });
    expect(result.data.uuid).toBe('aaaa0000-0000-0000-0000-000000000001');
  });

  it('returns empty requestId string when no requestId option is passed', async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.json({ uuid: 'any-uuid' })));
    const client = makeClient();
    const result = await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
    });
    expect(result.requestId).toBe('');
  });

  it('extracts RateLimit-Remaining and RateLimit-Reset headers', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse(JSON.stringify({ uuid: 'rate-uuid' }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'RateLimit-Remaining': '17',
              'RateLimit-Reset': '2026-04-29T12:00:00Z',
            },
          }),
      ),
    );
    const client = makeClient();
    const result = await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
    });
    expect(result.rateLimit.remaining).toBe(17);
    expect(result.rateLimit.resetAt).toBe('2026-04-29T12:00:00Z');
  });

  it('returns null rate-limit values when headers are absent', async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.json({ uuid: 'no-rl' })));
    const client = makeClient();
    const result = await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
    });
    expect(result.rateLimit.remaining).toBeNull();
    expect(result.rateLimit.resetAt).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 *  requestId option
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — requestId', () => {
  it('sends X-Request-Id header when requestId is provided', async () => {
    let capturedHeader: string | null = null;
    server.use(
      http.post(UPLOAD_URL, ({ request }) => {
        capturedHeader = request.headers.get('X-Request-Id');
        return HttpResponse.json({ uuid: 'req-id-uuid' });
      }),
    );
    const client = makeClient();
    await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
      requestId: 'my-request-id-1234',
    });
    expect(capturedHeader).toBe('my-request-id-1234');
  });

  it('echoes requestId in the response object when provided', async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.json({ uuid: 'echo-uuid' })));
    const client = makeClient();
    const result = await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
      requestId: 'echo-me-123',
    });
    expect(result.requestId).toBe('echo-me-123');
  });

  it('does not send X-Request-Id when requestId is omitted', async () => {
    let capturedHeader: string | null | undefined = undefined;
    server.use(
      http.post(UPLOAD_URL, ({ request }) => {
        capturedHeader = request.headers.get('X-Request-Id');
        return HttpResponse.json({ uuid: 'no-rid' });
      }),
    );
    const client = makeClient();
    await client.requestMultipart({
      path: UPLOAD_PATH,
      body: makeFormData(),
      schema: UuidSchema,
    });
    expect(capturedHeader).toBeNull();
  });
});

/* ---------------------------------------------------------------------------
 *  signal option
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — signal', () => {
  it('propagates an already-aborted signal from opts (throws, not wrapped)', async () => {
    // MSW still needs a handler for the URL even though fetch will abort
    // before the request completes.
    server.use(
      http.post(UPLOAD_URL, async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return HttpResponse.json({ uuid: 'never' });
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
        signal: controller.signal,
      });
    } catch (err) {
      caught = err;
    }
    // AbortError is re-thrown as-is, not wrapped in NetworkError.
    expect(caught).not.toBeInstanceOf(NetworkError);
    expect((caught as Error).name).toMatch(/Abort/i);
  });

  it('propagates an already-aborted signal from the constructor', async () => {
    server.use(
      http.post(UPLOAD_URL, async () => {
        await new Promise((r) => setTimeout(r, 5000));
        return HttpResponse.json({ uuid: 'never' });
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const client = new HttpClient({ ...TEST_OPTS, signal: controller.signal });
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as Error).name).toMatch(/Abort/i);
  });
});

/* ---------------------------------------------------------------------------
 *  Network failure
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — network failure', () => {
  it('wraps fetch transport errors in NetworkError', async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.error()));
    const client = makeClient();
    await expect(
      client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      }),
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('NetworkError message includes the path', async () => {
    server.use(http.post(UPLOAD_URL, () => HttpResponse.error()));
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as NetworkError).message).toContain(UPLOAD_PATH);
  });
});

/* ---------------------------------------------------------------------------
 *  429 — no retry, immediate throw
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — 429 rate limit', () => {
  it('throws RateLimitedError with retryAfterSec when Retry-After header is numeric', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '45' },
          }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSec).toBe(45);
  });

  it('throws RateLimitedError without retryAfterSec when Retry-After header is absent', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).retryAfterSec).toBeUndefined();
  });

  it('threads requestId into the RateLimitedError when 429 has requestId option', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
        requestId: 'rl-req-id',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitedError);
    expect((caught as RateLimitedError).requestId).toBe('rl-req-id');
  });
});

/* ---------------------------------------------------------------------------
 *  401
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — 401', () => {
  it('throws FreeloApiError AUTH_EXPIRED when body has parseable errors array', async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).code).toBe('AUTH_EXPIRED');
    expect((caught as FreeloApiError).errors).toContain('Invalid token');
  });

  it('throws FreeloApiError AUTH_EXPIRED even when 401 body is unparseable', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          // Return a non-JSON body so the catch in the 401 handler fires.
          new HttpResponse('not json', { status: 401, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).code).toBe('AUTH_EXPIRED');
    // errors is always an array on FreeloApiError; when body is unparseable it
    // defaults to an empty array (the catch block swallows the parse error).
    expect((caught as FreeloApiError).errors).toHaveLength(0);
  });
});

/* ---------------------------------------------------------------------------
 *  4xx / 5xx (non-401)
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — 4xx / 5xx', () => {
  it('throws FreeloApiError with parsed errors on 400 with errors body', async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json({ errors: ['File type not allowed.'] }, { status: 400 }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(400);
    expect((caught as FreeloApiError).errors).toEqual(['File type not allowed.']);
  });

  it('throws FreeloApiError on 5xx with parseable error body', async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json({ errors: ['Internal server error.'] }, { status: 500 }),
      ),
    );
    const client = makeClient();
    await expect(
      client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      }),
    ).rejects.toBeInstanceOf(FreeloApiError);
  });

  it('throws FreeloApiError on 5xx even when body is unparseable', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse('not json', { status: 500, headers: { 'Content-Type': 'text/plain' } }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(500);
  });

  it('marks 5xx as retryable', async () => {
    server.use(
      http.post(UPLOAD_URL, () =>
        HttpResponse.json({ errors: ['Server error.'] }, { status: 503 }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as FreeloApiError).retryable).toBe(true);
  });

  it('marks 4xx (non-401) as not retryable', async () => {
    server.use(
      http.post(UPLOAD_URL, () => HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 })),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as FreeloApiError).retryable).toBe(false);
  });
});

/* ---------------------------------------------------------------------------
 *  2xx with bad body
 * ------------------------------------------------------------------------- */

describe('HttpClient.requestMultipart — 2xx parse failures', () => {
  it('throws FreeloApiError when JSON parsing fails on a 200 body', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse('not valid json', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).code).toBe('FREELO_API_ERROR');
    expect((caught as FreeloApiError).message).toMatch(/Failed to parse JSON/);
  });

  it('throws FreeloApiError VALIDATION_ERROR when the schema rejects a 200 body', async () => {
    server.use(
      // uuid is missing — schema rejects it
      http.post(UPLOAD_URL, () => HttpResponse.json({ result: 'ok', unexpected: true })),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).code).toBe('VALIDATION_ERROR');
  });

  it('includes requestId in the JSON-parse-failure error when option is set', async () => {
    server.use(
      http.post(
        UPLOAD_URL,
        () =>
          new HttpResponse('not json', {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );
    const client = makeClient();
    let caught: unknown;
    try {
      await client.requestMultipart({
        path: UPLOAD_PATH,
        body: makeFormData(),
        schema: UuidSchema,
        requestId: 'parse-fail-req-id',
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as FreeloApiError).requestId).toBe('parse-fail-req-id');
  });
});
