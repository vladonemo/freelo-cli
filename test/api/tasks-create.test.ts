/**
 * Unit tests for `src/api/tasks-create.ts` (R09 spec 0019 §5 + spec 0041
 * label-fix).
 *
 * `buildCreateTaskBody` is a pure mapping from CLI input to the wire shape.
 * Tests assert every mapping rule:
 *   - priority enum: low → l, normal → m, high → h
 *   - due_date wire format: YYYY-MM-DD → YYYY-MM-DDT00:00:00Z (decision 1)
 *   - description → comment.content
 *   - labels are NEVER on the wire body (spec 0041 §5.1) — they travel
 *     out-of-band via a follow-up POST /task-labels/add-to-task call.
 *   - undefined-field omission (matches R07's filter convention)
 */

import { describe, expect, it } from 'vitest';
import { buildCreateTaskBody, createTaskPath } from '../../src/api/tasks-create.js';

describe('buildCreateTaskBody', () => {
  it('emits only `name` when no optional fields are set', () => {
    const body = buildCreateTaskBody({ name: 'Audit auth' });
    expect(body).toEqual({ name: 'Audit auth' });
  });

  it('maps --priority high → priority_enum h', () => {
    const body = buildCreateTaskBody({ name: 'X', priority: 'high' });
    expect(body.priority_enum).toBe('h');
  });

  it('maps --priority normal → priority_enum m', () => {
    const body = buildCreateTaskBody({ name: 'X', priority: 'normal' });
    expect(body.priority_enum).toBe('m');
  });

  it('maps --priority low → priority_enum l', () => {
    const body = buildCreateTaskBody({ name: 'X', priority: 'low' });
    expect(body.priority_enum).toBe('l');
  });

  it('appends T00:00:00Z to --due (decision 1)', () => {
    const body = buildCreateTaskBody({ name: 'X', due: '2026-05-01' });
    expect(body.due_date).toBe('2026-05-01T00:00:00Z');
  });

  it('passes worker through unchanged', () => {
    const body = buildCreateTaskBody({ name: 'X', worker: 17 });
    expect(body.worker).toBe(17);
  });

  it('wraps non-empty description in { comment: { content } }', () => {
    const body = buildCreateTaskBody({ name: 'X', description: 'Long body.' });
    expect(body.comment).toEqual({ content: 'Long body.' });
  });

  it('omits comment when description is empty string', () => {
    const body = buildCreateTaskBody({ name: 'X', description: '' });
    expect('comment' in body).toBe(false);
  });

  it('drops labels from the wire body even when input.labels is non-empty (spec 0041 §5.1)', () => {
    const body = buildCreateTaskBody({ name: 'X', labels: ['blocker', 'qa'] });
    expect('labels' in body).toBe(false);
  });

  it('drops labels when the input array is empty', () => {
    const body = buildCreateTaskBody({ name: 'X', labels: [] });
    expect('labels' in body).toBe(false);
  });

  it('emits the full body when every field is set — labels still absent', () => {
    const body = buildCreateTaskBody({
      name: 'Big task',
      due: '2026-06-01',
      worker: 42,
      priority: 'high',
      description: 'Body text',
      labels: ['a', 'b'],
    });
    expect(body).toEqual({
      name: 'Big task',
      due_date: '2026-06-01T00:00:00Z',
      worker: 42,
      priority_enum: 'h',
      comment: { content: 'Body text' },
    });
    expect('labels' in body).toBe(false);
  });
});

describe('createTaskPath', () => {
  it('returns the expected path for given ids', () => {
    expect(createTaskPath(42, 314)).toBe('/project/42/tasklist/314/tasks');
  });
});
