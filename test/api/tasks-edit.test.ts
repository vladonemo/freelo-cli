/**
 * Unit tests for `src/api/tasks-edit.ts` (R10 spec 0020 §5).
 *
 * Two parts:
 *   1. `buildEditTaskBody` is a pure mapping from CLI input to the wire shape.
 *      Tests assert every mapping rule from §5: priority enum, due_date wire
 *      format, undefined-field omission, `clearPriority` → `null` emit, all-
 *      empty input → `{}`.
 *   2. `addTaskLabels` / `removeTaskLabels` short-circuit when names is empty
 *      (no HTTP call). Tests use a fake `HttpClient` to assert the wire body
 *      and skip behavior — no MSW needed.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  addLabelsPath,
  addTaskLabels,
  buildEditTaskBody,
  editTaskPath,
  isEmptyEditBody,
  removeLabelsPath,
  removeTaskLabels,
} from '../../src/api/tasks-edit.js';
import type { HttpClient } from '../../src/api/client.js';

describe('buildEditTaskBody', () => {
  it('emits {} when no fields are set (caller must skip the POST)', () => {
    const body = buildEditTaskBody({});
    expect(body).toEqual({});
    expect(isEmptyEditBody(body)).toBe(true);
  });

  it('maps --priority high → priority_enum h', () => {
    expect(buildEditTaskBody({ priority: 'high' })).toEqual({ priority_enum: 'h' });
  });

  it('maps --priority normal → priority_enum m', () => {
    expect(buildEditTaskBody({ priority: 'normal' })).toEqual({ priority_enum: 'm' });
  });

  it('maps --priority low → priority_enum l', () => {
    expect(buildEditTaskBody({ priority: 'low' })).toEqual({ priority_enum: 'l' });
  });

  it('emits priority_enum: null on --clear-priority (decision: explicit null)', () => {
    expect(buildEditTaskBody({ clearPriority: true })).toEqual({ priority_enum: null });
  });

  it('priority wins when both priority and clearPriority are set (defensive)', () => {
    // The command layer rejects this combo; the builder is permissive and
    // picks `priority` deterministically (mirrors Object.assign-with-precedence).
    expect(buildEditTaskBody({ priority: 'high', clearPriority: true })).toEqual({
      priority_enum: 'h',
    });
  });

  it('appends T00:00:00Z to --due (matches R09 wire format)', () => {
    expect(buildEditTaskBody({ due: '2026-05-01' })).toEqual({
      due_date: '2026-05-01T00:00:00Z',
    });
  });

  it('passes name through unchanged', () => {
    expect(buildEditTaskBody({ name: 'New name' })).toEqual({ name: 'New name' });
  });

  it('passes worker through unchanged', () => {
    expect(buildEditTaskBody({ worker: 17 })).toEqual({ worker: 17 });
  });

  it('emits the full body when every editable field is set', () => {
    expect(
      buildEditTaskBody({
        name: 'Updated',
        due: '2026-06-01',
        worker: 42,
        priority: 'low',
      }),
    ).toEqual({
      name: 'Updated',
      due_date: '2026-06-01T00:00:00Z',
      worker: 42,
      priority_enum: 'l',
    });
  });

  it('isEmptyEditBody returns false when at least one field is set', () => {
    expect(isEmptyEditBody({ name: 'X' })).toBe(false);
    expect(isEmptyEditBody({ priority_enum: null })).toBe(false);
  });
});

describe('path helpers', () => {
  it('editTaskPath formats /task/<id>', () => {
    expect(editTaskPath(9012)).toBe('/task/9012');
  });
  it('addLabelsPath formats /task-labels/add-to-task/<id>', () => {
    expect(addLabelsPath(9012)).toBe('/task-labels/add-to-task/9012');
  });
  it('removeLabelsPath formats /task-labels/remove-from-task/<id>', () => {
    expect(removeLabelsPath(9012)).toBe('/task-labels/remove-from-task/9012');
  });
});

/**
 * Fake `HttpClient` good enough for unit testing the label wrappers.
 * Records every `request()` call so the test can assert on it.
 */
function fakeClient(): HttpClient & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const request = vi.fn((opts: Record<string, unknown>) => {
    calls.push(opts);
    return Promise.resolve({
      data: { result: 'success' },
      rateLimit: { remaining: 99, resetAt: '2026-04-27T20:30:00Z' },
      requestId: 'req-fake',
    });
  });
  // Cast through unknown — the real HttpClient is a class with private fields;
  // for these tests only `request` is exercised.
  return Object.assign({ request, calls }, { calls }) as unknown as HttpClient & {
    calls: Array<Record<string, unknown>>;
  };
}

describe('addTaskLabels', () => {
  it('skips the HTTP call when names is empty', async () => {
    const client = fakeClient();
    const result = await addTaskLabels(client, 9012, []);
    expect(result.names).toEqual([]);
    expect(result.raw).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it('posts {labels:[{name}]} for each name, in order', async () => {
    const client = fakeClient();
    const result = await addTaskLabels(client, 9012, ['urgent', 'p0']);
    expect(result.names).toEqual(['urgent', 'p0']);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/task-labels/add-to-task/9012');
    expect(client.calls[0]!['body']).toEqual({
      labels: [{ name: 'urgent' }, { name: 'p0' }],
    });
  });
});

describe('removeTaskLabels', () => {
  it('skips the HTTP call when names is empty', async () => {
    const client = fakeClient();
    const result = await removeTaskLabels(client, 9012, []);
    expect(result.names).toEqual([]);
    expect(result.raw).toBeNull();
    expect(client.calls).toHaveLength(0);
  });

  it('posts {labels:[{name}]} for each name, in order', async () => {
    const client = fakeClient();
    const result = await removeTaskLabels(client, 9012, ['wontfix']);
    expect(result.names).toEqual(['wontfix']);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/task-labels/remove-from-task/9012');
    expect(client.calls[0]!['body']).toEqual({ labels: [{ name: 'wontfix' }] });
  });
});
