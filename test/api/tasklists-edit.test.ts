/**
 * Unit tests for the pure helpers in `src/api/tasklists-edit.ts` (M02, spec 0065).
 *
 * No I/O, no MSW — these cover the body builder, the path builder and the
 * empty-body predicate. The wire encodings asserted here are the load-bearing
 * part of the slice: `null` clears vs. absent keys vs. `0` as a real value.
 */

import { describe, expect, it } from 'vitest';
import {
  buildEditTasklistBody,
  editTasklistPath,
  isEmptyEditBody,
} from '../../src/api/tasklists-edit.js';
import { EditTasklistResponseSchema } from '../../src/api/schemas/tasklist.js';

describe('buildEditTasklistBody — only set keys are emitted', () => {
  it('empty input produces an empty body', () => {
    expect(buildEditTasklistBody({})).toEqual({});
  });

  it('name only', () => {
    expect(buildEditTasklistBody({ name: 'QA checklist' })).toEqual({ name: 'QA checklist' });
  });

  it('never serializes undefined for unset fields', () => {
    const body = buildEditTasklistBody({ name: 'x' });
    // `'budget' in body` would be true if we assigned undefined.
    expect(Object.keys(body)).toEqual(['name']);
    expect(JSON.stringify(body)).toBe('{"name":"x"}');
  });

  it('maximal input maps every field to its wire name', () => {
    const body = buildEditTasklistBody({
      name: 'Sprint 12',
      budget: '100000',
      timeBudgetMinutes: 480,
      worker: 77,
      trackingUsers: [12, 34],
      shouldChangeExistingTasks: true,
      priority: 1,
    });
    expect(body).toEqual({
      name: 'Sprint 12',
      budget: '100000',
      time_budget_minutes: 480,
      priority: 1,
      tracking_users_ids: [12, 34],
      should_change_existing_tasks: true,
      worker_id: 77,
    });
  });
});

describe('buildEditTasklistBody — clear semantics (decision 8)', () => {
  it('--clear-budget sends null, not "0"', () => {
    expect(buildEditTasklistBody({ clearBudget: true })).toEqual({ budget: null });
  });

  it('--clear-time-budget sends null', () => {
    expect(buildEditTasklistBody({ clearTimeBudget: true })).toEqual({
      time_budget_minutes: null,
    });
  });

  it('--clear-worker sends null', () => {
    expect(buildEditTasklistBody({ clearWorker: true })).toEqual({ worker_id: null });
  });

  it('--clear-tracking-users sends an empty array, not null', () => {
    expect(buildEditTasklistBody({ clearTrackingUsers: true })).toEqual({
      tracking_users_ids: [],
    });
  });

  it('all three nullable clears are uniform on the wire', () => {
    const body = buildEditTasklistBody({
      clearBudget: true,
      clearTimeBudget: true,
      clearWorker: true,
    });
    expect(body).toEqual({ budget: null, time_budget_minutes: null, worker_id: null });
  });

  it('an explicit value wins over its clear flag (builder stays total)', () => {
    // The command layer rejects this combination first; the builder must not
    // throw or produce a half-formed body if it ever arrives.
    expect(buildEditTasklistBody({ budget: '500', clearBudget: true })).toEqual({ budget: '500' });
    expect(buildEditTasklistBody({ worker: 9, clearWorker: true })).toEqual({ worker_id: 9 });
    expect(buildEditTasklistBody({ trackingUsers: [1], clearTrackingUsers: true })).toEqual({
      tracking_users_ids: [1],
    });
    expect(buildEditTasklistBody({ timeBudgetMinutes: 5, clearTimeBudget: true })).toEqual({
      time_budget_minutes: 5,
    });
  });
});

describe('buildEditTasklistBody — time budget 0 is a value, not a clear', () => {
  it('timeBudgetMinutes: 0 emits 0', () => {
    const body = buildEditTasklistBody({ timeBudgetMinutes: 0 });
    expect(body).toEqual({ time_budget_minutes: 0 });
    expect(body.time_budget_minutes).not.toBeNull();
  });

  it('0 and clear produce different wire values', () => {
    expect(buildEditTasklistBody({ timeBudgetMinutes: 0 })).not.toEqual(
      buildEditTasklistBody({ clearTimeBudget: true }),
    );
  });
});

describe('buildEditTasklistBody — tracking users dedupe (decision 7)', () => {
  it('dedupes preserving first-seen order', () => {
    expect(buildEditTasklistBody({ trackingUsers: [34, 12, 34, 12, 56] })).toEqual({
      tracking_users_ids: [34, 12, 56],
    });
  });

  it('a single id round-trips unchanged', () => {
    expect(buildEditTasklistBody({ trackingUsers: [7] })).toEqual({ tracking_users_ids: [7] });
  });

  it('an explicitly empty list behaves like a clear', () => {
    expect(buildEditTasklistBody({ trackingUsers: [] })).toEqual({ tracking_users_ids: [] });
  });
});

describe('buildEditTasklistBody — should_change_existing_tasks', () => {
  it('is omitted entirely when not opted in (server default is false)', () => {
    const body = buildEditTasklistBody({ trackingUsers: [1] });
    expect('should_change_existing_tasks' in body).toBe(false);
  });

  it('is emitted as true when opted in', () => {
    const body = buildEditTasklistBody({ trackingUsers: [1], shouldChangeExistingTasks: true });
    expect(body.should_change_existing_tasks).toBe(true);
  });
});

describe('isEmptyEditBody', () => {
  it('true for an empty body', () => {
    expect(isEmptyEditBody({})).toBe(true);
  });

  it('true when only should_change_existing_tasks is set (it is not mutating)', () => {
    expect(isEmptyEditBody({ should_change_existing_tasks: true })).toBe(true);
  });

  it('false for a name change', () => {
    expect(isEmptyEditBody({ name: 'x' })).toBe(false);
  });

  it('false for a null clear — clearing IS mutating', () => {
    expect(isEmptyEditBody({ budget: null })).toBe(false);
    expect(isEmptyEditBody({ worker_id: null })).toBe(false);
    expect(isEmptyEditBody({ time_budget_minutes: null })).toBe(false);
  });

  it('false for an empty follower list — clearing followers IS mutating', () => {
    expect(isEmptyEditBody({ tracking_users_ids: [] })).toBe(false);
  });

  it('false for time_budget_minutes: 0', () => {
    expect(isEmptyEditBody({ time_budget_minutes: 0 })).toBe(false);
  });
});

describe('editTasklistPath', () => {
  it('builds the documented path', () => {
    expect(editTasklistPath(9001)).toBe('/tasklist/9001/edit');
  });
});

describe('EditTasklistResponseSchema', () => {
  it('accepts both boolean values', () => {
    expect(EditTasklistResponseSchema.parse({ priorityApplied: true }).priorityApplied).toBe(true);
    expect(EditTasklistResponseSchema.parse({ priorityApplied: false }).priorityApplied).toBe(
      false,
    );
  });

  it('rejects a body missing the required priorityApplied field', () => {
    expect(() => EditTasklistResponseSchema.parse({})).toThrow();
  });

  it('rejects a non-boolean priorityApplied', () => {
    expect(() => EditTasklistResponseSchema.parse({ priorityApplied: 'yes' })).toThrow();
  });

  it('passes through unknown future fields', () => {
    const parsed = EditTasklistResponseSchema.parse({ priorityApplied: true, futureField: 42 });
    expect((parsed as Record<string, unknown>)['futureField']).toBe(42);
  });
});
