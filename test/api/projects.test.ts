import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHttpClient } from '../../src/api/client.js';
import {
  getOwnedProjects,
  getAllProjects,
  getInvitedProjects,
  getArchivedProjects,
  getTemplateProjects,
} from '../../src/api/projects.js';
import { server, projectsHandlers, API_BASE } from '../msw/handlers.js';
import { FreeloApiError } from '../../src/errors/freelo-api-error.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../fixtures/projects', name);
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

describe('getOwnedProjects', () => {
  it('returns a synthesized single-page NormalizedPage from the bare array', async () => {
    const fixture = await loadFixture<unknown[]>('owned.json');
    server.use(projectsHandlers.ownedOk(fixture));

    const client = makeClient();
    const out = await getOwnedProjects(client, {});
    expect(out.page.data).toHaveLength(3);
    expect(out.page.page).toBe(0);
    expect(out.page.perPage).toBe(3);
    expect(out.page.total).toBe(3);
    expect(out.page.nextCursor).toBeNull();
  });

  it('surfaces 401 as FreeloApiError with code AUTH_EXPIRED', async () => {
    server.use(projectsHandlers.unauthorized('owned'));
    const client = makeClient();
    await expect(getOwnedProjects(client, {})).rejects.toThrow(FreeloApiError);
  });
});

describe('getAllProjects', () => {
  it('parses the wrapper and computes nextCursor', async () => {
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('all-page0.json');
    server.use(projectsHandlers.pagedOk('all', { 0: fixture }));

    const client = makeClient();
    const out = await getAllProjects(client, { page: 0 });
    expect(out.page.page).toBe(0);
    expect(out.page.total).toBe(75);
    expect(out.page.perPage).toBe(25);
    expect(out.page.nextCursor).toBe(1);
    expect(out.page.data).toHaveLength(2);
  });

  it('returns nextCursor: null on the last page', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      projectsHandlers.pagedOk('all', {
        2: fixture as never,
      }),
    );
    const client = makeClient();
    const out = await getAllProjects(client, { page: 2 });
    expect(out.page.nextCursor).toBeNull();
  });

  it('surfaces 5xx as a retryable FreeloApiError (SERVER_ERROR)', async () => {
    server.use(projectsHandlers.serverError('all', 503));
    const client = makeClient();
    await expect(getAllProjects(client, { page: 0 })).rejects.toMatchObject({
      code: 'SERVER_ERROR',
    });
  });

  it('rejects a malformed wrapper missing the inner key', async () => {
    server.use(projectsHandlers.malformedWrapper('all'));
    const client = makeClient();
    await expect(getAllProjects(client, { page: 0 })).rejects.toThrow();
  });
});

describe('getInvitedProjects / getArchivedProjects / getTemplateProjects', () => {
  it('each reads from its own inner-key wrapper', async () => {
    const inviteFixture = {
      total: 1,
      count: 1,
      page: 0,
      per_page: 25,
      data: { invited_projects: [{ id: 100, name: 'Invited' }] },
    };
    const archivedFixture = {
      total: 1,
      count: 1,
      page: 0,
      per_page: 25,
      data: { archived_projects: [{ id: 200, name: 'Archived' }] },
    };
    const templatesFixture = {
      total: 1,
      count: 1,
      page: 0,
      per_page: 25,
      data: { template_projects: [{ id: 300, name: 'Template' }] },
    };

    server.use(
      projectsHandlers.pagedOk('invited', { 0: inviteFixture }),
      projectsHandlers.pagedOk('archived', { 0: archivedFixture }),
      projectsHandlers.pagedOk('templates', { 0: templatesFixture }),
    );

    const client = makeClient();
    const inv = await getInvitedProjects(client, { page: 0 });
    const arch = await getArchivedProjects(client, { page: 0 });
    const tpl = await getTemplateProjects(client, { page: 0 });
    expect(inv.page.data[0]?.id).toBe(100);
    expect(arch.page.data[0]?.id).toBe(200);
    expect(tpl.page.data[0]?.id).toBe(300);
  });
});
