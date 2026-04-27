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
import { type Subtask } from '../../src/api/schemas/task.js';

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
  it('returns "simple" for the lean shape (only id+task_id+name)', () => {
    const s = { id: 1, task_id: 9012, name: 'lean' } as Subtask;
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
