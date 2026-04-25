import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, API_BASE } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { RateLimitedError } from '../../src/errors/rate-limited-error.js';
import { UserMeEnvelopeSchema } from '../../src/api/schemas/users-me.js';
import { VERSION } from '../../src/lib/version.js';

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/magic-soft/freelo-cli)`,
};

/**
 * Rate-limit retry tests use vi.useFakeTimers() so we don't actually sleep.
 * The client uses setTimeout internally; fake timers advance them synchronously.
 *
 * Pattern:
 *   1. Start the request (stores the promise).
 *   2. Attach a no-op .catch() immediately to prevent "unhandled rejection"
 *      warnings while timers haven't fired yet.
 *   3. Advance timers with vi.runAllTimersAsync().
 *   4. Await the stored promise for assertions — the rejection is now handled.
 */
describe('HttpClient — GET 429 retry budget', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries GET up to 3 attempts and throws RateLimitedError when all return 429', async () => {
    let callCount = 0;
    server.use(
      http.get(`${API_BASE}/users/me`, () => {
        callCount++;
        return new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
        });
      }),
    );

    const client = new HttpClient(TEST_OPTS);
    const promise = client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    // Suppress unhandled-rejection warnings while timers are pending.
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow(RateLimitedError);
    // Should have tried 3 times (initial + 2 retries = 3 total attempts)
    expect(callCount).toBe(3);
  });

  it('throws RateLimitedError with retryAfterSec when Retry-After header is numeric', async () => {
    server.use(
      http.get(
        `${API_BASE}/users/me`,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '30' },
          }),
      ),
    );

    const client = new HttpClient(TEST_OPTS);
    const promise = client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      // retryAfterSec should reflect the header value (30 s header → 30 s)
      expect((err as RateLimitedError).retryAfterSec).toBe(30);
    }
  });

  it('throws RateLimitedError even without Retry-After header', async () => {
    server.use(
      http.get(
        `${API_BASE}/users/me`,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const client = new HttpClient(TEST_OPTS);
    const promise = client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    await expect(promise).rejects.toThrow(RateLimitedError);
  });

  it('succeeds on the 3rd attempt when the first two return 429', async () => {
    let callCount = 0;
    server.use(
      http.get(`${API_BASE}/users/me`, () => {
        callCount++;
        if (callCount < 3) {
          return new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '1' },
          });
        }
        return HttpResponse.json({ result: 'success', user: { id: 12345 } });
      }),
    );

    const client = new HttpClient(TEST_OPTS);
    const promise = client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    // No .catch() needed here — on success this won't reject.

    await vi.runAllTimersAsync();

    const result = await promise;
    expect(result.data.user.id).toBe(12345);
    expect(callCount).toBe(3);
  });
});

describe('HttpClient — write 429 does not retry', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('throws RateLimitedError immediately for POST 429 (no retry)', async () => {
    let callCount = 0;
    server.use(
      http.post(`${API_BASE}/tasks`, () => {
        callCount++;
        return new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
          status: 429,
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    const { z } = await import('zod');
    const client = new HttpClient(TEST_OPTS);
    await expect(
      client.request({
        method: 'POST',
        path: '/tasks',
        body: { name: 'task' },
        schema: z.object({ id: z.number() }),
      }),
    ).rejects.toThrow(RateLimitedError);

    // Must not retry — only 1 call
    expect(callCount).toBe(1);
  });
});

describe('HttpClient — RateLimitedError properties', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('sets exitCode 6 on exhausted GET RateLimitedError', async () => {
    server.use(
      http.get(
        `${API_BASE}/users/me`,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const client = new HttpClient(TEST_OPTS);
    const promise = client.request({
      method: 'GET',
      path: '/users/me',
      schema: UserMeEnvelopeSchema,
    });
    promise.catch(() => {});

    await vi.runAllTimersAsync();

    try {
      await promise;
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitedError);
      expect((err as RateLimitedError).exitCode).toBe(6);
      expect((err as RateLimitedError).retryable).toBe(true);
    }
  });
});
