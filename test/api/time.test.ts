/**
 * Unit tests for the time-tracking wire wrappers (R19, spec 0030).
 *
 * Covers the API layer in `src/api/time.ts`:
 *   - `buildStartTimerBody` (omits unspecified keys).
 *   - `startTimer` happy path (200 → uuid).
 *   - `startTimer` 409 → raw `FreeloApiError` propagates (the leaf rewrites the hint).
 *   - `getTimerStatus` 200 → wire shape returned.
 *   - `getTimerStatus` 204 → `status === null`.
 *   - `getTimerStatus` 401 → `FreeloApiError` (exit 3).
 */

import { afterAll, beforeAll, afterEach, describe, expect, it } from 'vitest';
import { server, API_BASE, timeHandlers } from '../msw/handlers.js';
import { HttpClient } from '../../src/api/client.js';
import { VERSION } from '../../src/lib/version.js';
import { buildStartTimerBody, getTimerStatus, startTimer } from '../../src/api/time.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

const TEST_OPTS = {
  email: 'test@example.cz',
  apiKey: 'sk-test-key',
  apiBaseUrl: API_BASE,
  userAgent: `freelo-cli/${VERSION} (+https://github.com/vladonemo/freelo-cli)`,
};

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());
afterEach(() => server.resetHandlers());

describe('buildStartTimerBody', () => {
  it('returns {} when no input fields are provided', () => {
    expect(buildStartTimerBody({})).toEqual({});
  });

  it('includes only task_id when only taskId is supplied', () => {
    expect(buildStartTimerBody({ taskId: 4567 })).toEqual({ task_id: 4567 });
  });

  it('includes only note when only note is supplied', () => {
    expect(buildStartTimerBody({ note: 'hello' })).toEqual({ note: 'hello' });
  });

  it('includes both fields when both are supplied', () => {
    expect(buildStartTimerBody({ taskId: 4567, note: 'hello' })).toEqual({
      task_id: 4567,
      note: 'hello',
    });
  });
});

describe('startTimer', () => {
  it('returns the uuid on 200 OK', async () => {
    server.use(timeHandlers.startOk('tt-uuid-abc'));
    const client = new HttpClient(TEST_OPTS);
    const { response } = await startTimer(client, { body: { task_id: 4567 } });
    expect(response.uuid).toBe('tt-uuid-abc');
  });

  it('throws FreeloApiError on 409 (singleton conflict; rewrite happens at leaf)', async () => {
    server.use(timeHandlers.startConflict());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await startTimer(client, { body: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(409);
    expect(e.code).toBe('FREELO_API_ERROR');
    expect(e.exitCode).toBe(4);
  });

  it('throws FreeloApiError on 401 (auth)', async () => {
    server.use(timeHandlers.startUnauthorized());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await startTimer(client, { body: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).exitCode).toBe(3);
  });

  it('throws FreeloApiError on 5xx', async () => {
    server.use(timeHandlers.startServerError(503));
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await startTimer(client, { body: {} });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(503);
    expect(e.code).toBe('SERVER_ERROR');
    expect(e.retryable).toBe(true);
  });

  it('captures the request body', async () => {
    let captured: unknown;
    server.use(
      timeHandlers.startOkWhenBody((body) => {
        captured = body;
        return true;
      }, 'tt-uuid-cap'),
    );
    const client = new HttpClient(TEST_OPTS);
    await startTimer(client, { body: { task_id: 99, note: 'capture me' } });
    expect(captured).toEqual({ task_id: 99, note: 'capture me' });
  });
});

describe('getTimerStatus', () => {
  it('returns the wire shape on 200 active', async () => {
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-active',
        date_reported: '2026-04-28T10:00:00Z',
        task: { id: 4567, name: 'Investigate', project: { id: 11, name: 'Web' }, tasklist: null },
        note: 'wip',
        is_billable: true,
        is_cost_fixed: false,
        cost: { amount: '100', currency: 'CZK' },
        labels: [{ name: 'bug' }],
        project_setting: null,
      }),
    );
    const client = new HttpClient(TEST_OPTS);
    const { status } = await getTimerStatus(client);
    expect(status).not.toBeNull();
    if (status === null) throw new Error('expected non-null');
    expect(status.uuid).toBe('tt-uuid-active');
    expect(status.task?.id).toBe(4567);
  });

  it('returns null on 204 No Content (no active timer)', async () => {
    server.use(timeHandlers.statusInactive());
    const client = new HttpClient(TEST_OPTS);
    const { status } = await getTimerStatus(client);
    expect(status).toBeNull();
  });

  it('throws FreeloApiError on 401', async () => {
    server.use(timeHandlers.statusUnauthorized());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await getTimerStatus(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).exitCode).toBe(3);
  });

  it('throws FreeloApiError on 5xx', async () => {
    server.use(timeHandlers.statusServerError(502));
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await getTimerStatus(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).httpStatus).toBe(502);
  });
});
