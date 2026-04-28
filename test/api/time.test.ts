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
import {
  buildEditTimerBody,
  buildStartTimerBody,
  editTimer,
  getTimerStatus,
  startTimer,
  stopTimer,
} from '../../src/api/time.js';
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

/* ---------------------------------------------------------------------------
 *  R20 — stopTimer (POST /timetracking/stop)
 * ------------------------------------------------------------------------- */

const SAMPLE_WORK_REPORT = {
  id: 987,
  date_add: '2026-04-28T15:30:00Z',
  date_reported: '2026-04-28',
  minutes: 42,
  note: 'WIP',
  cost: { amount: '0', currency: 'CZK' },
  author: { id: 1, fullname: 'agent' },
  worker: { id: 1, fullname: 'agent' },
  task: { id: 4567, name: 'Investigate bug' },
};

describe('stopTimer', () => {
  it('returns the parsed WorkReport on 200 OK', async () => {
    server.use(timeHandlers.stopOk(SAMPLE_WORK_REPORT));
    const client = new HttpClient(TEST_OPTS);
    const { workReport } = await stopTimer(client);
    expect(workReport.id).toBe(987);
    expect(workReport.minutes).toBe(42);
    expect(workReport.task?.id).toBe(4567);
  });

  it('parses a WorkReport with task: null (general work)', async () => {
    server.use(
      timeHandlers.stopOk({
        id: 988,
        date_add: '2026-04-28T15:31:00Z',
        date_reported: '2026-04-28',
        minutes: 7,
        note: null,
        cost: null,
        author: { id: 1, fullname: 'agent' },
        worker: { id: 1, fullname: 'agent' },
        task: null,
      }),
    );
    const client = new HttpClient(TEST_OPTS);
    const { workReport } = await stopTimer(client);
    expect(workReport.task).toBeNull();
    expect(workReport.minutes).toBe(7);
  });

  it('throws FreeloApiError on 409 (no active session)', async () => {
    server.use(timeHandlers.stopConflict());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await stopTimer(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(409);
    expect(e.code).toBe('FREELO_API_ERROR');
    expect(e.exitCode).toBe(4);
  });

  it('throws FreeloApiError on 401', async () => {
    server.use(timeHandlers.stopUnauthorized());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await stopTimer(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).exitCode).toBe(3);
  });

  it('throws FreeloApiError on 5xx (retryable)', async () => {
    server.use(timeHandlers.stopServerError(503));
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await stopTimer(client);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(503);
    expect(e.retryable).toBe(true);
  });
});

/* ---------------------------------------------------------------------------
 *  R20 — buildEditTimerBody / editTimer (POST /timetracking/edit)
 * ------------------------------------------------------------------------- */

describe('buildEditTimerBody', () => {
  it('returns {} when no input fields are provided', () => {
    expect(buildEditTimerBody({})).toEqual({});
  });

  it('includes only task_id when only taskId is supplied', () => {
    expect(buildEditTimerBody({ taskId: 4567 })).toEqual({ task_id: 4567 });
  });

  it('includes task_id: null when taskId is explicitly null (--no-task)', () => {
    expect(buildEditTimerBody({ taskId: null })).toEqual({ task_id: null });
  });

  it('includes only note when only note is supplied', () => {
    expect(buildEditTimerBody({ note: 'updated' })).toEqual({ note: 'updated' });
  });

  it('includes both fields when both are supplied', () => {
    expect(buildEditTimerBody({ taskId: 4567, note: 'updated' })).toEqual({
      task_id: 4567,
      note: 'updated',
    });
  });

  it('preserves empty-string note (server accepts)', () => {
    expect(buildEditTimerBody({ note: '' })).toEqual({ note: '' });
  });
});

describe('editTimer', () => {
  it('returns the uuid on 200 OK', async () => {
    server.use(timeHandlers.editTimerOk('tt-uuid-edited-1'));
    const client = new HttpClient(TEST_OPTS);
    const { response } = await editTimer(client, { body: { task_id: 4567 } });
    expect(response.uuid).toBe('tt-uuid-edited-1');
  });

  it('captures the request body (task_id + note)', async () => {
    let captured: unknown;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body;
        return true;
      }, 'tt-uuid-edited-cap'),
    );
    const client = new HttpClient(TEST_OPTS);
    await editTimer(client, { body: { task_id: 99, note: 'capture me' } });
    expect(captured).toEqual({ task_id: 99, note: 'capture me' });
  });

  it('captures task_id: null on the wire (--no-task)', async () => {
    let captured: unknown;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body;
        return true;
      }, 'tt-uuid-edited-null'),
    );
    const client = new HttpClient(TEST_OPTS);
    await editTimer(client, { body: { task_id: null } });
    expect(captured).toEqual({ task_id: null });
  });

  it('throws FreeloApiError on 409 (no active session)', async () => {
    server.use(timeHandlers.editTimerConflict());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await editTimer(client, { body: { note: 'x' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(409);
    expect(e.exitCode).toBe(4);
  });

  it('throws FreeloApiError on 401', async () => {
    server.use(timeHandlers.editTimerUnauthorized());
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await editTimer(client, { body: { note: 'x' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    expect((caught as FreeloApiError).exitCode).toBe(3);
  });

  it('throws FreeloApiError on 5xx (retryable)', async () => {
    server.use(timeHandlers.editTimerServerError(502));
    const client = new HttpClient(TEST_OPTS);
    let caught: unknown;
    try {
      await editTimer(client, { body: { note: 'x' } });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FreeloApiError);
    const e = caught as FreeloApiError;
    expect(e.httpStatus).toBe(502);
    expect(e.retryable).toBe(true);
  });
});
