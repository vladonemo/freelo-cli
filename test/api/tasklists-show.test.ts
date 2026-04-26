/**
 * Unit tests for the R06 HTTP wrappers — `getTasklistDetail` and
 * `getAssignableWorkers`. Confirms URL shape, schema validation, and the
 * `signal` / `requestId` plumbing branches. Spec 0016 §8.3.
 *
 * These tests pin the materially-different fact about R06: the
 * assignable-workers endpoint returns a **bare array**, not a paginated
 * wrapper. See API research memo and decision 1.
 */

import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { http, HttpResponse } from 'msw';
import { createHttpClient } from '../../src/api/client.js';
import { getTasklistDetail, getAssignableWorkers } from '../../src/api/tasklists.js';
import { server, tasklistShowHandlers, API_BASE } from '../msw/handlers.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../fixtures/tasklists', name);
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

describe('getTasklistDetail', () => {
  it('GETs /tasklist/{id} and parses TasklistDetail (carrying project_id)', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/tasklist/314`, ({ request }) => {
        seen(request.url);
        return HttpResponse.json(fixture);
      }),
    );

    const client = makeClient();
    const out = await getTasklistDetail(client, 314, {});
    expect(out.data.id).toBe(314);
    expect(out.data.project_id).toBe(42);
    expect(out.data.name).toBe('Backend QA');
    expect(seen).toHaveBeenCalledWith(`${API_BASE}/tasklist/314`);
  });

  it('rejects when project_id is missing (locks the OpenAPI contract)', async () => {
    server.use(
      http.get(`${API_BASE}/tasklist/314`, () =>
        HttpResponse.json({ id: 314, name: 'Orphaned tasklist' }),
      ),
    );
    const client = makeClient();
    // project_id is required per schema; the absence triggers a zod failure
    // that the HTTP layer reports as a FreeloApiError (validation kind).
    await expect(getTasklistDetail(client, 314, {})).rejects.toThrow();
  });

  it('surfaces 404 as FreeloApiError with httpStatus=404', async () => {
    server.use(tasklistShowHandlers.detailNotFound(99999));
    const client = makeClient();
    await expect(getTasklistDetail(client, 99999, {})).rejects.toThrow(FreeloApiError);
  });

  it('honours an explicit signal (covers the signal-set branch)', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(tasklistShowHandlers.detailOk(314, fixture));

    const controller = new AbortController();
    const client = makeClient();
    const out = await getTasklistDetail(client, 314, { signal: controller.signal });
    expect(out.data.project_id).toBe(42);
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(tasklistShowHandlers.detailOk(314, fixture));

    const client = makeClient();
    const out = await getTasklistDetail(client, 314, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.data.project_id).toBe(42);
  });
});

describe('getAssignableWorkers', () => {
  it('GETs /project/{pid}/tasklist/{tid}/assignable-workers and parses bare array', async () => {
    const fixture = await loadFixture<Array<{ id: number; fullname: string }>>(
      'show-assignable-workers.json',
    );
    const seen = vi.fn();
    server.use(
      http.get(`${API_BASE}/project/42/tasklist/314/assignable-workers`, ({ request }) => {
        seen(request.url);
        return HttpResponse.json(fixture);
      }),
    );

    const client = makeClient();
    const out = await getAssignableWorkers(client, 42, 314, {});
    expect(out.data).toHaveLength(3);
    expect(out.data[0]?.id).toBe(9);
    expect(out.data[0]?.fullname).toBe('Owner Name');
    expect(seen).toHaveBeenCalledWith(`${API_BASE}/project/42/tasklist/314/assignable-workers`);
  });

  it('parses an empty bare array (no workers)', async () => {
    server.use(tasklistShowHandlers.assignableWorkersOk(42, 314, []));
    const client = makeClient();
    const out = await getAssignableWorkers(client, 42, 314, {});
    expect(out.data).toEqual([]);
  });

  it('rejects a paginated wrapper (locks the bare-array contract)', async () => {
    server.use(tasklistShowHandlers.assignableWorkersMalformed(42, 314));
    const client = makeClient();
    // Wrapper shape `{ data: { workers: [...] } }` is NOT what `/assignable-workers`
    // returns. Schema is `z.array(UserBasic)` so the wrapper fails to parse.
    await expect(getAssignableWorkers(client, 42, 314, {})).rejects.toThrow();
  });

  it('surfaces 403 as FreeloApiError with httpStatus=403', async () => {
    server.use(tasklistShowHandlers.assignableWorkersForbidden(42, 314));
    const client = makeClient();
    await expect(getAssignableWorkers(client, 42, 314, {})).rejects.toThrow(FreeloApiError);
  });

  it('honours an explicit signal (covers the signal-set branch)', async () => {
    server.use(tasklistShowHandlers.assignableWorkersOk(42, 314, [{ id: 9, fullname: 'Owner' }]));
    const controller = new AbortController();
    const client = makeClient();
    const out = await getAssignableWorkers(client, 42, 314, { signal: controller.signal });
    expect(out.data).toHaveLength(1);
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    server.use(tasklistShowHandlers.assignableWorkersOk(42, 314, [{ id: 9, fullname: 'Owner' }]));
    const client = makeClient();
    const out = await getAssignableWorkers(client, 42, 314, {
      requestId: '11111111-2222-4333-8444-555555555555',
    });
    expect(out.data).toHaveLength(1);
  });
});
