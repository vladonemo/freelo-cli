/**
 * Unit tests for `src/api/subtasks.ts` (R14 spec 0025 §4.3 / §4.4).
 *
 * Pure-function tests — no MSW, no I/O.
 *   - `buildCreateSubtaskBody`: CLI input → wire body.
 *   - `inferStorageForm`: response shape → `'smart' | 'simple'`.
 *   - `createSubtaskPath`: deterministic path resolver.
 */

import { describe, expect, it } from 'vitest';
import {
  buildCreateSubtaskBody,
  createSubtaskPath,
  inferStorageForm,
} from '../../src/api/subtasks.js';
import { type Subtask, SubtaskSchema } from '../../src/api/schemas/task.js';

describe('buildCreateSubtaskBody', () => {
  it('emits only `name` when no optional fields are set', () => {
    const body = buildCreateSubtaskBody({ name: 'Subtask A' });
    expect(body).toEqual({ name: 'Subtask A' });
  });

  it('appends T00:00:00Z to --due (mirrors R09 decision 1)', () => {
    const body = buildCreateSubtaskBody({ name: 'X', due: '2026-05-01' });
    expect(body.due_date).toBe('2026-05-01T00:00:00Z');
  });

  it('passes worker through unchanged', () => {
    const body = buildCreateSubtaskBody({ name: 'X', worker: 17 });
    expect(body.worker).toBe(17);
  });

  it('emits all three fields when all are set', () => {
    const body = buildCreateSubtaskBody({ name: 'X', worker: 17, due: '2026-05-01' });
    expect(body).toEqual({
      name: 'X',
      due_date: '2026-05-01T00:00:00Z',
      worker: 17,
    });
  });

  it('omits worker key entirely when undefined (does not emit `worker: null`)', () => {
    const body = buildCreateSubtaskBody({ name: 'X', due: '2026-05-01' });
    expect('worker' in body).toBe(false);
  });

  it('omits due_date key entirely when undefined', () => {
    const body = buildCreateSubtaskBody({ name: 'X', worker: 17 });
    expect('due_date' in body).toBe(false);
  });
});

describe('createSubtaskPath', () => {
  it('formats /task/<id>/subtasks', () => {
    expect(createSubtaskPath(9012)).toBe('/task/9012/subtasks');
  });

  it('handles 1-digit ids', () => {
    expect(createSubtaskPath(1)).toBe('/task/1/subtasks');
  });
});

describe('inferStorageForm', () => {
  // The two shapes below are copied verbatim from a live capture against a
  // Freelo test account on 2026-08-30 (R14) — see
  // docs/runs/2026-08-29-2230-r14-subtask-type/fixture-capture.md
  //
  // The previous version of this test asserted 'simple' for
  // `{ id: 1, task_id: 9012, name: 'lean' }`. That is a shape the API never
  // produces: a populated `task_id` means the subtask is *smart*
  // (`type: 'subtask'`); a simple taskcheck has `task_id: null`. It passed
  // only because `inferStorageForm` never inspects `task_id`.

  it('returns "simple" for a real simple-taskcheck create response', () => {
    const s = {
      id: 18510610,
      task_id: null,
      name: 'R14 nested subtask (expect taskcheck fallback)',
      due_date: null,
      due_date_end: null,
      worker: null,
    } as Subtask;
    expect(inferStorageForm(s)).toBe('simple');
  });

  it('known divergence: reads a real *smart* create response as "simple"', () => {
    // GET /task/32125435/subtasks reports `type: 'subtask'` for this id, but
    // the create response is lean, so the heuristic cannot see it. This is
    // asserted deliberately: it pins current behaviour so the gap is visible
    // rather than surprising. See the doc comment on `inferStorageForm`.
    const s = {
      id: 18510609,
      task_id: 32125436,
      name: 'R14 first subtask (expect smart)',
      due_date: null,
      due_date_end: null,
      worker: null,
    } as Subtask;
    expect(inferStorageForm(s)).toBe('simple');
  });

  it('returns "simple" for {id, name} (even task_id missing)', () => {
    const s = { id: 1, name: 'lean' } as Subtask;
    expect(inferStorageForm(s)).toBe('simple');
  });

  it('returns "smart" when worker is populated', () => {
    const s = { id: 1, name: 'x', worker: { id: 7, fullname: 'A' } } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('returns "smart" when due_date is populated', () => {
    const s = { id: 1, name: 'x', due_date: '2026-05-01T00:00:00Z' } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('returns "smart" when due_date_end is populated', () => {
    const s = { id: 1, name: 'x', due_date_end: '2026-05-02T00:00:00Z' } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('returns "smart" when state is populated', () => {
    const s = { id: 1, name: 'x', state: { id: 1, state: 'active' } } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('returns "smart" when tasklist is populated', () => {
    const s = { id: 1, name: 'x', tasklist: { id: 5, name: 'tl' } } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('returns "smart" when project is populated', () => {
    const s = { id: 1, name: 'x', project: { id: 5, name: 'p' } } as Subtask;
    expect(inferStorageForm(s)).toBe('smart');
  });

  it('treats null rich fields as absent (returns "simple")', () => {
    const s = {
      id: 1,
      name: 'x',
      worker: null,
      due_date: null,
      state: null,
      tasklist: null,
      project: null,
    } as Subtask;
    expect(inferStorageForm(s)).toBe('simple');
  });
});

describe('SubtaskSchema.type (R14)', () => {
  // Values below are from the live capture on 2026-08-30 —
  // docs/runs/2026-08-29-2230-r14-subtask-type/fixture-capture.md

  it('parses type "subtask" from a GET element (smart)', () => {
    const parsed = SubtaskSchema.parse({
      id: 18510609,
      type: 'subtask',
      task_id: 32125436,
      name: 'R14 first subtask (expect smart)',
    });
    expect(parsed.type).toBe('subtask');
    expect(parsed.task_id).toBe(32125436);
  });

  it('parses type "taskcheck" from a GET element, with task_id null', () => {
    const parsed = SubtaskSchema.parse({
      id: 18510610,
      type: 'taskcheck',
      task_id: null,
      name: 'R14 nested subtask (expect taskcheck fallback)',
    });
    expect(parsed.type).toBe('taskcheck');
    expect(parsed.task_id).toBeNull();
  });

  it('accepts a create response that omits type entirely (POST shape)', () => {
    // POST /task/{id}/subtasks returns no `type` key at all. This is the
    // reason the field is optional; see the schema doc comment.
    const parsed = SubtaskSchema.parse({
      id: 18510609,
      task_id: 32125436,
      name: 'R14 first subtask (expect smart)',
      worker: null,
    });
    expect(parsed.type).toBeUndefined();
  });

  it('rejects an unknown type value rather than passing it through', () => {
    // Deliberate: strict enum matches how `state` is handled elsewhere in
    // src/api/schemas. The trade-off is that a new server-side kind would
    // fail validation rather than degrade — flagged in the R14 changeset.
    expect(() => SubtaskSchema.parse({ id: 1, type: 'milestone' })).toThrow();
  });
});
