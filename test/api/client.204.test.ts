/**
 * Regression test for the 204-No-Content branch of `HttpClient.request`
 * (R19, spec 0030 §2.5).
 *
 * The branch was added to support `GET /timetracking/status`, which returns
 * 204 (with empty body) when no timer is active. The client treats 204 as
 * "feed `null` to the schema" — schemas that accept `null` succeed; schemas
 * that don't fail with a typed `FreeloApiError` (`VALIDATION_ERROR`).
 */

import { afterAll, beforeAll, beforeEach, afterEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { z } from 'zod';
import { server, API_BASE } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';
import { VERSION } from '../../src/lib/version.js';

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/vladonemo/freelo-cli)`,
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

beforeEach(() => {
  server.use(http.get(`${API_BASE}/__test/empty`, () => new HttpResponse(null, { status: 204 })));
});

describe('HttpClient — 204 No Content branch (R19, spec 0030 §2.5)', () => {
  it('feeds null to the schema; null-accepting schema parses through', async () => {
    const schema = z.union([z.null(), z.object({ uuid: z.string() })]);
    const client = new HttpClient(TEST_OPTS);
    const result = await client.request({
      method: 'GET',
      path: '/__test/empty',
      schema,
    });
    expect(result.data).toBe(null);
  });

  it('throws FreeloApiError VALIDATION_ERROR when schema rejects null', async () => {
    const schema = z.object({ uuid: z.string() });
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await client.request({ method: 'GET', path: '/__test/empty', schema });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.exitCode).toBe(4);
    expect(e.message).toContain('204 No Content');
  });

  it('preserves rateLimit headers on 204 responses', async () => {
    server.use(
      http.get(
        `${API_BASE}/__test/empty-with-headers`,
        () =>
          new HttpResponse(null, {
            status: 204,
            headers: { 'RateLimit-Remaining': '42', 'RateLimit-Reset': '2026-04-28T11:00:00Z' },
          }),
      ),
    );
    const schema = z.null();
    const client = new HttpClient(TEST_OPTS);
    const result = await client.request({
      method: 'GET',
      path: '/__test/empty-with-headers',
      schema,
    });
    expect(result.data).toBe(null);
    expect(result.rateLimit.remaining).toBe(42);
    expect(result.rateLimit.resetAt).toBe('2026-04-28T11:00:00Z');
  });
});
