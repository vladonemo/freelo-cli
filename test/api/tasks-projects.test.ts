/**
 * Unit tests for `src/api/tasks-projects.ts` (R38 spec 0052).
 *
 * These cover the four wire wrappers and — crucially — exercise the
 * `signal` / `requestId` opt-spread branches that command-level tests
 * never trigger (commands don't pass either). Without these the
 * `src/api/**` branch threshold (80%) dips below the gate.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  assignTaskPath,
  assignTaskToProject,
  removeTaskFromProject,
  removeTaskFromProjectPath,
} from '../../src/api/tasks-projects.js';
import type { HttpClient } from '../../src/api/client.js';

describe('tasks-projects path helpers', () => {
  it('assignTaskPath formats /task/<id>/projects', () => {
    expect(assignTaskPath(101)).toBe('/task/101/projects');
  });

  it('removeTaskFromProjectPath formats /task/<id>/projects/<project_id>', () => {
    expect(removeTaskFromProjectPath(101, 42)).toBe('/task/101/projects/42');
  });
});

describe('assignTaskToProject', () => {
  it('POSTs { tasklist_id } to the assign path', async () => {
    const client = fakeClient({ task: { id: 999, uuid: 'u-1' } });
    const result = await assignTaskToProject(client, 101, 42);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/task/101/projects');
    expect(client.calls[0]!['body']).toEqual({ tasklist_id: 42 });
    expect(result.body.task.id).toBe(999);
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ task: { id: 1, uuid: 'u' } });
    const ac = new AbortController();
    await assignTaskToProject(client, 101, 42, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
    expect(client.calls[0]!['requestId']).toBeUndefined();
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ task: { id: 1, uuid: 'u' } });
    await assignTaskToProject(client, 101, 42, { requestId: 'req-abc' });
    expect(client.calls[0]!['requestId']).toBe('req-abc');
    expect(client.calls[0]!['signal']).toBeUndefined();
  });
});

describe('removeTaskFromProject', () => {
  it('DELETEs to the per-project path with no body', async () => {
    const client = fakeClient({ result: 'success' });
    await removeTaskFromProject(client, 101, 42);
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('DELETE');
    expect(client.calls[0]!['path']).toBe('/task/101/projects/42');
    expect(client.calls[0]!['body']).toBeUndefined();
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({ result: 'success' });
    const ac = new AbortController();
    await removeTaskFromProject(client, 101, 42, { signal: ac.signal });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({ result: 'success' });
    await removeTaskFromProject(client, 101, 42, { requestId: 'req-xyz' });
    expect(client.calls[0]!['requestId']).toBe('req-xyz');
  });
});

/**
 * Minimal fake `HttpClient` — records every `request()` call. The schema is
 * not actually validated (we cast unknown response data through), which is
 * fine for wire-shape and opt-threading tests.
 */
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
