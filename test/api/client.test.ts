import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { server, API_BASE } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { NetworkError } from '../../src/errors/network-error.js';
import { VERSION } from '../../src/lib/version.js';
import { UserMeEnvelopeSchema } from '../../src/api/schemas/users-me.js';

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/magic-soft/freelo-cli)`,
};

function makeClient(overrides?: Partial<typeof TEST_OPTS>) {
  return new HttpClient({ ...TEST_OPTS, ...overrides });
}

describe('HttpClient — Basic Auth header', () => {
  let capturedAuth: string | null = null;

  beforeEach(() => {
    capturedAuth = null;
    server.use(
      http.get(`${API_BASE}/users/me`, ({ request }) => {
        capturedAuth = request.headers.get('Authorization');
        return HttpResponse.json({ result: 'success', user: { id: 1 } });
      }),
    );
  });

  afterEach(() => {
    capturedAuth = null;
  });

  it('sends Authorization: Basic <base64(email:apiKey)>', async () => {
    const client = makeClient();
    await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    const expected = `Basic ${Buffer.from('test@example.cz:sk-test-key').toString('base64')}`;
    expect(capturedAuth).toBe(expected);
  });
});

describe('HttpClient — required headers', () => {
  let capturedHeaders: Record<string, string> = {};

  beforeEach(() => {
    capturedHeaders = {};
    server.use(
      http.get(`${API_BASE}/users/me`, ({ request }) => {
        request.headers.forEach((value, key) => {
          capturedHeaders[key.toLowerCase()] = value;
        });
        return HttpResponse.json({ result: 'success', user: { id: 1 } });
      }),
    );
  });

  it('sends User-Agent header matching the expected format', async () => {
    const client = makeClient();
    await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    expect(capturedHeaders['user-agent']).toContain('freelo-cli/');
  });

  it('sends Accept: application/json on every request', async () => {
    const client = makeClient();
    await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    expect(capturedHeaders['accept']).toBe('application/json');
  });

  it('sends X-Request-Id when provided in the request options', async () => {
    const client = makeClient();
    const requestId = '550e8400-e29b-41d4-a716-446655440000';
    await client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
      requestId,
    });
    expect(capturedHeaders['x-request-id']).toBe(requestId);
  });

  it('does not send Content-Type on GET requests', async () => {
    const client = makeClient();
    await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    expect(capturedHeaders['content-type']).toBeUndefined();
  });
});

describe('HttpClient — successful 200 response', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ result: 'success', user: { id: 12345, email: 'jane@example.cz' } }),
      ),
    );
  });

  it('returns the parsed data when the schema matches', async () => {
    const client = makeClient();
    const { data } = await client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    expect(data.user.id).toBe(12345);
  });

  it('returns rateLimit with null values when no rate-limit headers are present', async () => {
    const client = makeClient();
    const { rateLimit } = await client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    expect(rateLimit.remaining).toBeNull();
    expect(rateLimit.resetAt).toBeNull();
  });

  it('returns rateLimit.remaining from RateLimit-Remaining header', async () => {
    server.use(
      http.get(
        `${API_BASE}/users/me`,
        () =>
          new HttpResponse(JSON.stringify({ result: 'success', user: { id: 1 } }), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'RateLimit-Remaining': '42',
            },
          }),
      ),
    );
    const client = makeClient();
    const { rateLimit } = await client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    expect(rateLimit.remaining).toBe(42);
  });
});

describe('HttpClient — 401 response', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ errors: [{ message: 'Invalid token' }] }, { status: 401 }),
      ),
    );
  });

  it('throws FreeloApiError with code AUTH_EXPIRED on 401', async () => {
    const client = makeClient();
    await expect(
      client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema }),
    ).rejects.toThrow(FreeloApiError);
  });

  it('throws FreeloApiError with AUTH_EXPIRED code on 401', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).code).toBe('AUTH_EXPIRED');
    }
  });

  it('throws FreeloApiError with exitCode 3 on 401', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect((err as FreeloApiError).exitCode).toBe(3);
    }
  });

  it('includes the normalized error message in errors array', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect((err as FreeloApiError).errors).toContain('Invalid token');
    }
  });
});

describe('HttpClient — 401 with global string-array error shape', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ errors: ['Invalid token'] }, { status: 401 }),
      ),
    );
  });

  it('normalizes string-array errors to string[] on 401', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect((err as FreeloApiError).errors).toEqual(['Invalid token']);
    }
  });
});

describe('HttpClient — 5xx response', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ errors: ['Internal server error.'] }, { status: 500 }),
      ),
    );
  });

  it('throws FreeloApiError on 500', async () => {
    const client = makeClient();
    await expect(
      client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema }),
    ).rejects.toThrow(FreeloApiError);
  });

  it('marks the error as retryable on 5xx', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect((err as FreeloApiError).retryable).toBe(true);
    }
  });

  it('has exitCode 4 on 5xx', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect((err as FreeloApiError).exitCode).toBe(4);
    }
  });
});

describe('HttpClient — 4xx non-401 response', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ errors: ['Forbidden.'] }, { status: 403 }),
      ),
    );
  });

  it('throws FreeloApiError with retryable false on 403', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).retryable).toBe(false);
    }
  });
});

describe('HttpClient — malformed 2xx body', () => {
  beforeEach(() => {
    // Missing user.id — passes zod only if schema is wrong
    server.use(
      http.get(`${API_BASE}/users/me`, () =>
        HttpResponse.json({ result: 'success', user: { name: 'oops' } }),
      ),
    );
  });

  it('throws FreeloApiError with VALIDATION_ERROR when zod fails on a 2xx body', async () => {
    const client = makeClient();
    try {
      await client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(FreeloApiError);
      expect((err as FreeloApiError).code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('HttpClient — network failure', () => {
  beforeEach(() => {
    server.use(
      http.get(`${API_BASE}/users/me`, () => {
        return HttpResponse.error();
      }),
    );
  });

  it('throws NetworkError when the fetch fails at the transport level', async () => {
    const client = makeClient();
    await expect(
      client.request({ method: 'GET', path: '/users/me', schema: UserMeEnvelopeSchema }),
    ).rejects.toThrow(NetworkError);
  });
});

describe('HttpClient — AbortSignal', () => {
  it('propagates the abort signal (throws on already-aborted signal)', async () => {
    server.use(
      http.get(`${API_BASE}/users/me`, async () => {
        // Simulate a slow response
        await new Promise((r) => setTimeout(r, 10000));
        return HttpResponse.json({ result: 'success', user: { id: 1 } });
      }),
    );

    const controller = new AbortController();
    controller.abort();

    const client = makeClient();
    // An already-aborted signal will cause fetch to throw immediately
    await expect(
      client.request({
        method: 'GET',
        path: '/users/me',
        schema: UserMeEnvelopeSchema,
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });
});

describe('HttpClient — write 429 does not retry', () => {
  let requestCount = 0;

  beforeEach(() => {
    requestCount = 0;
    server.use(
      http.post(`${API_BASE}/tasks`, () => {
        requestCount++;
        return new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
        });
      }),
    );
  });

  it('throws RateLimitedError immediately on POST 429 without retrying', async () => {
    const { RateLimitedError } = await import('../../src/errors/rate-limited-error.js');
    const client = makeClient();
    await expect(
      client.request({
        method: 'POST',
        path: '/tasks',
        body: { name: 'test' },
        schema: z.object({ id: z.number() }),
      }),
    ).rejects.toThrow(RateLimitedError);
    expect(requestCount).toBe(1);
  });
});
