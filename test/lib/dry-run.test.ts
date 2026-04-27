/**
 * Unit tests for `src/lib/dry-run.ts` (R09 spec 0019 §3.2).
 *
 * Pure-function builder; no I/O. Covers:
 *   - shape: dry_run flag present, would block spliced into data
 *   - optional fields: requestId, notice — only emitted when set
 *   - schema string passes through unchanged
 *
 * Calibration §1: dry-run is a public envelope shape. Asserts on every key
 * agents key off.
 */

import { describe, expect, it } from 'vitest';
import { dryRunEnvelope } from '../../src/lib/dry-run.js';

describe('dryRunEnvelope', () => {
  it('builds an envelope with dry_run: true and would spliced into data', () => {
    const env = dryRunEnvelope({
      schema: 'freelo.tasks.create/v1',
      data: { tasklist_id: 314, project_id: 42 },
      would: {
        method: 'POST',
        path: '/project/42/tasklist/314/tasks',
        body: { name: 'Test' },
      },
    });

    expect(env.schema).toBe('freelo.tasks.create/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.tasklist_id).toBe(314);
    expect(env.data.project_id).toBe(42);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/project/42/tasklist/314/tasks',
      body: { name: 'Test' },
    });
    // Optional fields absent.
    expect('request_id' in env).toBe(false);
    expect('notice' in env).toBe(false);
    expect('rate_limit' in env).toBe(false);
  });

  it('includes request_id when provided', () => {
    const env = dryRunEnvelope({
      schema: 'freelo.tasks.create/v1',
      data: { tasklist_id: 1, project_id: 1 },
      would: { method: 'POST', path: '/x', body: {} },
      requestId: 'abc-123',
    });
    expect(env.request_id).toBe('abc-123');
  });

  it('includes notice when provided', () => {
    const env = dryRunEnvelope({
      schema: 'freelo.tasks.create/v1',
      data: { tasklist_id: 1, project_id: 1 },
      would: { method: 'POST', path: '/x', body: {} },
      notice: 'discarded ids 5, 6',
    });
    expect(env.notice).toBe('discarded ids 5, 6');
  });

  it('preserves arbitrary user-supplied data fields alongside would', () => {
    const env = dryRunEnvelope({
      schema: 'freelo.tasks.create/v1',
      data: { tasklist_id: 7, project_id: 8, line_index: 3 },
      would: { method: 'POST', path: '/y', body: { foo: 'bar' } },
    });
    expect(env.data.line_index).toBe(3);
    expect(env.data.would.body).toEqual({ foo: 'bar' });
  });

  it('does not mutate the input data object', () => {
    const data = { tasklist_id: 1, project_id: 1 };
    const before = JSON.stringify(data);
    dryRunEnvelope({
      schema: 'freelo.tasks.create/v1',
      data,
      would: { method: 'POST', path: '/x', body: {} },
    });
    expect(JSON.stringify(data)).toBe(before);
    // The caller's data object should NOT have a `would` property added.
    expect('would' in data).toBe(false);
  });
});
