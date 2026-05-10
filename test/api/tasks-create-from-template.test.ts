/**
 * Unit tests for `src/api/tasks-create-from-template.ts` (R39 spec 0053).
 *
 * These cover the body builder, the path helper, and — crucially — exercise
 * the `signal` / `requestId` opt-spread branches that command-level tests
 * never trigger (commands don't pass either). Without these the
 * `src/api/**` branch threshold (80%) dips below the gate (calibration §4 —
 * R38 PR #96 finding).
 *
 * Pattern mirrors `test/api/tasks-projects.test.ts` and
 * `test/api/tasks-relations.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  buildCreateTaskFromTemplateBody,
  createTaskFromTemplate,
  createTaskFromTemplatePath,
} from '../../src/api/tasks-create-from-template.js';
import type { HttpClient } from '../../src/api/client.js';

describe('createTaskFromTemplatePath', () => {
  it('formats /task/create-from-template/<id>', () => {
    expect(createTaskFromTemplatePath(50)).toBe('/task/create-from-template/50');
  });

  it('handles large ids', () => {
    expect(createTaskFromTemplatePath(123456)).toBe('/task/create-from-template/123456');
  });
});

describe('buildCreateTaskFromTemplateBody', () => {
  it('minimal — only sourceTaskId → only task_id on the wire', () => {
    expect(
      buildCreateTaskFromTemplateBody({
        templateId: 50,
        sourceTaskId: 7,
      }),
    ).toEqual({ task_id: 7 });
  });

  it('all fields — every key is mapped', () => {
    expect(
      buildCreateTaskFromTemplateBody({
        templateId: 50,
        sourceTaskId: 7,
        targetProjectId: 100,
        targetTasklistId: 200,
        dateStart: '2026-09-01',
        workers: [11, 22],
      }),
    ).toEqual({
      task_id: 7,
      target_project_id: 100,
      target_tasklist_id: 200,
      preset_date_from: '2026-09-01',
      users_ids: [11, 22],
    });
  });

  it('workers undefined → omits users_ids', () => {
    const body = buildCreateTaskFromTemplateBody({ templateId: 50, sourceTaskId: 7 });
    expect(body).not.toHaveProperty('users_ids');
  });

  it('workers empty array → omits users_ids (R31 / spec 0047 convention)', () => {
    const body = buildCreateTaskFromTemplateBody({
      templateId: 50,
      sourceTaskId: 7,
      workers: [],
    });
    expect(body).not.toHaveProperty('users_ids');
  });

  it('workers populated → users_ids is a fresh array (no mutation)', () => {
    const workers = [11, 22];
    const body = buildCreateTaskFromTemplateBody({
      templateId: 50,
      sourceTaskId: 7,
      workers,
    });
    expect(body.users_ids).toEqual([11, 22]);
    // Builder must copy — caller's input array remains untouched on later mutation.
    expect(body.users_ids).not.toBe(workers);
  });

  it('targetProjectId undefined → omits target_project_id (omit-undefined branch)', () => {
    const body = buildCreateTaskFromTemplateBody({ templateId: 50, sourceTaskId: 7 });
    expect(body).not.toHaveProperty('target_project_id');
  });

  it('targetTasklistId undefined → omits target_tasklist_id', () => {
    const body = buildCreateTaskFromTemplateBody({ templateId: 50, sourceTaskId: 7 });
    expect(body).not.toHaveProperty('target_tasklist_id');
  });

  it('dateStart undefined → omits preset_date_from', () => {
    const body = buildCreateTaskFromTemplateBody({ templateId: 50, sourceTaskId: 7 });
    expect(body).not.toHaveProperty('preset_date_from');
  });
});

describe('createTaskFromTemplate', () => {
  it('POSTs the body to the create-from-template path', async () => {
    const client = fakeClient({
      id: 9100,
      name: 'Kickoff checklist',
      tasklist: { id: 200, name: 'Onboarding' },
    });

    const result = await createTaskFromTemplate(client, {
      templateId: 50,
      body: { task_id: 7 },
    });

    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]!['method']).toBe('POST');
    expect(client.calls[0]!['path']).toBe('/task/create-from-template/50');
    expect(client.calls[0]!['body']).toEqual({ task_id: 7 });
    expect(result.task.id).toBe(9100);
    expect(result.task.name).toBe('Kickoff checklist');
    expect(result.task.tasklist.id).toBe(200);
  });

  it('threads through opts.signal when provided (covers signal-spread branch)', async () => {
    const client = fakeClient({
      id: 9100,
      name: 'X',
      tasklist: { id: 200 },
    });
    const ac = new AbortController();
    await createTaskFromTemplate(client, {
      templateId: 50,
      body: { task_id: 7 },
      signal: ac.signal,
    });
    expect(client.calls[0]!['signal']).toBe(ac.signal);
    expect(client.calls[0]!['requestId']).toBeUndefined();
  });

  it('threads through opts.requestId when provided (covers requestId-spread branch)', async () => {
    const client = fakeClient({
      id: 9100,
      name: 'X',
      tasklist: { id: 200 },
    });
    await createTaskFromTemplate(client, {
      templateId: 50,
      body: { task_id: 7 },
      requestId: 'req-cft',
    });
    expect(client.calls[0]!['requestId']).toBe('req-cft');
    expect(client.calls[0]!['signal']).toBeUndefined();
  });

  it('omits both signal and requestId when neither provided (covers omit branches)', async () => {
    const client = fakeClient({
      id: 9100,
      name: 'X',
      tasklist: { id: 200 },
    });
    await createTaskFromTemplate(client, {
      templateId: 50,
      body: { task_id: 7 },
    });
    expect(client.calls[0]!['signal']).toBeUndefined();
    expect(client.calls[0]!['requestId']).toBeUndefined();
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
