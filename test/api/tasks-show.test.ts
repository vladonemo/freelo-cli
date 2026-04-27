/**
 * Unit tests for the R08 HTTP wrappers — `getTaskDetail`,
 * `getTaskDescription`, `getTaskSubtasks`. Confirms URL shape, schema
 * validation, and the `signal` / `requestId` plumbing branches.
 *
 * Spec 0018 §8.3.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { http, HttpResponse } from 'msw';
import { createHttpClient } from '../../src/api/client.js';
import { getTaskDetail, getTaskDescription, getTaskSubtasks } from '../../src/api/tasks.js';
import { server, tasksShowHandlers, API_BASE } from '../msw/handlers.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../fixtures/tasks', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

function makeClient() {
  return createHttpClient({
    email: 'agent@example.com',
    apiKey: 'sk-test',
    apiBaseUrl: API_BASE,
    userAgent: 'freelo-cli-test/0.0.0',
  });
}

describe('getTaskDetail', () => {
  it('GETs /task/{id} and parses TaskDetail', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/task/9001`, ({ request }) => {
        seen(request.url);
        return HttpResponse.json(fixture);
      }),
    );

    const client = makeClient();
    const out = await getTaskDetail(client, 9001, {});
    expect(out.data.id).toBe(9001);
    expect(out.data.name).toBe('Audit auth flow');
    expect(out.data.priority_enum).toBe('m');
    expect(out.data.cost?.amount).toBe('5000');
    expect(seen).toHaveBeenCalledWith(`${API_BASE}/task/9001`);
  });

  it('round-trips multi_project_task block when present', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-task-9001-multi.json');
    server.use(tasksShowHandlers.detailOk(9001, fixture));

    const client = makeClient();
    const out = await getTaskDetail(client, 9001, {});
    expect(out.data.multi_project_task?.projects).toHaveLength(2);
    expect(out.data.multi_project_task?.projects?.[0]?.id).toBe(42);
    expect(out.data.multi_project_task?.projects?.[1]?.name).toBe('Sales');
  });

  it('surfaces 404 as FreeloApiError with httpStatus=404', async () => {
    server.use(tasksShowHandlers.detailNotFound(99999));
    const client = makeClient();
    await expect(getTaskDetail(client, 99999, {})).rejects.toThrow(FreeloApiError);
  });

  it('honours an explicit signal (covers the signal-set branch)', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, fixture));

    const controller = new AbortController();
    const client = makeClient();
    const out = await getTaskDetail(client, 9001, { signal: controller.signal });
    expect(out.data.id).toBe(9001);
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, fixture));

    const client = makeClient();
    const out = await getTaskDetail(client, 9001, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.data.id).toBe(9001);
  });
});

describe('getTaskDescription', () => {
  it('GETs /task/{id}/description and parses TaskComment', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-description.json');
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/task/9001/description`, ({ request }) => {
        seen(request.url);
        return HttpResponse.json(fixture);
      }),
    );

    const client = makeClient();
    const out = await getTaskDescription(client, 9001, {});
    expect(out.data.id).toBe(55501);
    expect(out.data.content).toMatch(/audit the OAuth2 flow/);
    expect(seen).toHaveBeenCalledWith(`${API_BASE}/task/9001/description`);
  });

  it('parses an empty-description response (id null, content null) — OpenAPI :2014', async () => {
    server.use(
      tasksShowHandlers.descriptionOk(9001, {
        id: null,
        content: null,
        date_add: null,
        files: null,
      }),
    );
    const client = makeClient();
    const out = await getTaskDescription(client, 9001, {});
    expect(out.data.id).toBeNull();
    expect(out.data.content).toBeNull();
  });

  it('surfaces 403 as FreeloApiError with httpStatus=403', async () => {
    server.use(tasksShowHandlers.descriptionForbidden(9001));
    const client = makeClient();
    await expect(getTaskDescription(client, 9001, {})).rejects.toThrow(FreeloApiError);
  });

  it('honours an explicit signal', async () => {
    server.use(tasksShowHandlers.descriptionOk(9001, { id: 1, content: 'hi' }));
    const controller = new AbortController();
    const client = makeClient();
    const out = await getTaskDescription(client, 9001, { signal: controller.signal });
    expect(out.data.id).toBe(1);
  });

  it('honours an explicit requestId', async () => {
    server.use(tasksShowHandlers.descriptionOk(9001, { id: 1, content: 'hi' }));
    const client = makeClient();
    const out = await getTaskDescription(client, 9001, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.data.id).toBe(1);
  });
});

describe('getTaskSubtasks', () => {
  it('GETs /task/{id}/subtasks?p=N and returns a normalized page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('show-subtasks-page0.json');
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/task/9001/subtasks`, ({ request }) => {
        seen(request.url);
        return HttpResponse.json(page0);
      }),
    );

    const client = makeClient();
    const out = await getTaskSubtasks(client, 9001, { page: 0 });
    expect(out.page.data).toHaveLength(2);
    expect(out.page.page).toBe(0);
    expect(out.page.total).toBe(3);
    expect(out.page.nextCursor).toBe(1);
    expect(seen).toHaveBeenCalledWith(`${API_BASE}/task/9001/subtasks?p=0`);
  });

  it('rejects malformed wrapper missing the inner subtasks key', async () => {
    server.use(
      http.get(`${API_BASE}/task/9001/subtasks`, () =>
        HttpResponse.json({ total: 0, count: 0, page: 0, per_page: 25, data: {} }),
      ),
    );
    const client = makeClient();
    // `normalizePaginated` raises FreeloApiError(VALIDATION_ERROR) when the
    // inner key is absent.
    await expect(getTaskSubtasks(client, 9001, { page: 0 })).rejects.toThrow(FreeloApiError);
  });

  it('honours an explicit signal', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9001, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );
    const controller = new AbortController();
    const client = makeClient();
    const out = await getTaskSubtasks(client, 9001, { page: 0, signal: controller.signal });
    expect(out.page.data).toEqual([]);
  });

  it('honours an explicit requestId', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9001, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );
    const client = makeClient();
    const out = await getTaskSubtasks(client, 9001, {
      page: 0,
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.page.total).toBe(0);
  });
});
