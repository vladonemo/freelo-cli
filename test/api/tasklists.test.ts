import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHttpClient } from '../../src/api/client.js';
import { getAllTasklists } from '../../src/api/tasklists.js';
import { server, tasklistsHandlers, API_BASE } from '../msw/handlers.js';
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

describe('getAllTasklists', () => {
  it('parses the wrapper and computes nextCursor', async () => {
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: fixture }));

    const client = makeClient();
    const out = await getAllTasklists(client, { page: 0 });
    expect(out.page.data).toHaveLength(3);
    expect(out.page.page).toBe(0);
    expect(out.page.perPage).toBe(3);
    expect(out.page.total).toBe(7);
    expect(out.page.nextCursor).toBe(1);
  });

  it('passes ?projects_ids[]=<id> when projectId is set', async () => {
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('project-42-page0.json');
    server.use(tasklistsHandlers.allByProject(42, { 0: fixture }));

    const client = makeClient();
    const out = await getAllTasklists(client, { page: 0, projectId: 42 });
    expect(out.page.data).toHaveLength(2);
    expect(out.page.total).toBe(2);
    expect(out.page.nextCursor).toBeNull();
  });

  it('honours an explicit signal (covers the signal-set branch)', async () => {
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: fixture }));

    const controller = new AbortController();
    const client = makeClient();
    const out = await getAllTasklists(client, { page: 0, signal: controller.signal });
    expect(out.page.data).toHaveLength(3);
  });

  it('honours an explicit requestId (covers the requestId-set branch)', async () => {
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: fixture }));

    const client = makeClient();
    const out = await getAllTasklists(client, {
      page: 0,
      requestId: '11111111-2222-3333-4444-555555555555',
    });
    expect(out.page.data).toHaveLength(3);
  });

  it('surfaces 401 as FreeloApiError', async () => {
    server.use(tasklistsHandlers.unauthorized());
    const client = makeClient();
    await expect(getAllTasklists(client, { page: 0 })).rejects.toThrow(FreeloApiError);
  });

  it('rejects malformed wrapper missing the inner tasklists key', async () => {
    server.use(tasklistsHandlers.malformedWrapper());
    const client = makeClient();
    await expect(getAllTasklists(client, { page: 0 })).rejects.toThrow(FreeloApiError);
  });
});
