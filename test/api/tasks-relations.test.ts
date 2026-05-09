/**
 * Unit tests for `src/api/tasks-relations.ts` (R38 spec 0052).
 *
 * Mirrors `tasks-projects.test.ts`: covers wire shape + the `signal` /
 * `requestId` opt-spread branches that command tests never hit.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  findTaskRelations,
  findTaskRelationsPath,
  getTaskRelations,
  taskRelationsPath,
} from '../../src/api/tasks-relations.js';
import type { HttpClient } from '../../src/api/client.js';

describe('tasks-relations path helpers', () => {
  it('taskRelationsPath formats /task/<id>/relations', () => {
    expect(taskRelationsPath(7)).toBe('/task/7/relations');
  });

  it('findTaskRelationsPath is the constant /tasks/relations', () => {
    expect(findTaskRelationsPath()).toBe('/tasks/relations');
  });
});

describe('getTaskRelations', () => {
  it('GETs the per-task relations path', async () => {
    const client = fakeClient({ relations: [] });
    await getTaskRelations(client, 7);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('GET');
    expect(client.calls[0]!['path']).toBe('/task/7/relations');
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ relations: [] });
    const ac = new AbortController();
    await getTaskRelations(client, 7, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ relations: [] });
    await getTaskRelations(client, 7, { requestId: 'req-rel' });
    expect(client.calls[0]!['requestId']).toBe('req-rel');
  });
});

describe('findTaskRelations', () => {
  it('POSTs { task_ids: [...] } to /tasks/relations', async () => {
    const client = fakeClient({ tasks: [] });
    await findTaskRelations(client, [11, 22, 33]);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/tasks/relations');
    expect(client.calls[0]!['body']).toEqual({ task_ids: [11, 22, 33] });
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ tasks: [] });
    const ac = new AbortController();
    await findTaskRelations(client, [1], { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ tasks: [] });
    await findTaskRelations(client, [1], { requestId: 'req-find' });
    expect(client.calls[0]!['requestId']).toBe('req-find');
  });
});

function fakeClient(data: unknown): HttpClient & {
  calls: Array<Record<string, unknown>>;
} {
  const calls: Array<Record<string, unknown>> = [];
  const request = vi.fn((opts: Record<string, unknown>) => {
    calls.push(opts);
    return Promise.resolve({
      data,
      rateLimit: { remaining: 99, resetAt: '2026-05-09T21:30:00Z' },
      requestId: 'req-fake',
    });
  });
  return Object.assign({ request, calls }, { calls }) as unknown as HttpClient & {
    calls: Array<Record<string, unknown>>;
  };
}
