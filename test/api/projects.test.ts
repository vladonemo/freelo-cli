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

  it('parses real-shape responses where client is null (regression: R03 null-client)', async () => {
    const fixture = await loadFixture<unknown[]>('owned-with-null-client.json');
    server.use(projectsHandlers.ownedOk(fixture));

    const client = makeClient();
    const out = await getOwnedProjects(client, {});
    expect(out.page.data).toHaveLength(3);
    // All three carry client: null on the wire; the parser must preserve it.
    for (const p of out.page.data) {
      expect((p as { client: unknown }).client).toBeNull();
    }
    // tasklists: null (item 1) and missing (item 2) round-trip distinctly.
    expect((out.page.data[1] as { tasklists: unknown }).tasklists).toBeNull();
    expect((out.page.data[2] as { tasklists?: unknown }).tasklists).toBeUndefined();
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

  it('R05.5 — parses /all-projects with numeric real_cost.amount and budget.amount', async () => {
    // Reproducer for R05.5 Bug #2: live Freelo returns Currency.amount as
    // a number for real_cost / budget. The schema must accept both shapes
    // and normalize to string in the parsed envelope. See spec 0015 §2.
    const fixture = await loadFixture<{
      total: number;
      count: number;
      page: number;
      per_page: number;
      data: Record<string, unknown[]>;
    }>('all-with-numeric-amounts.json');
    server.use(projectsHandlers.pagedOk('all', { 0: fixture }));

    const client = makeClient();
    const out = await getAllProjects(client, { page: 0 });
    expect(out.page.data).toHaveLength(3);

    const records = out.page.data as Array<{
      id: number;
      budget?: { amount: string; currency: string } | null;
      real_cost?: { amount: string; currency: string } | null;
      owner?: { id: number; fullname?: string | null } | null;
    }>;

    // Numeric amounts come back as strings (Bug #2 normalization).
    expect(records[0]?.real_cost?.amount).toBe('2000');
    expect(records[0]?.budget?.amount).toBe('50000');
    expect(typeof records[0]?.real_cost?.amount).toBe('string');

    // Fractional preserved as decimal string.
    expect(records[1]?.real_cost?.amount).toBe('15000.5');

    // Mixed shapes within the same response — both normalize to string.
    expect(records[2]?.budget?.amount).toBe('100000'); // already a string
    expect(records[2]?.real_cost?.amount).toBe('9999'); // was a number

    // Bug #1 — owner with id only (no fullname) parses cleanly.
    expect(records[2]?.owner?.id).toBe(17);
    expect(records[2]?.owner?.fullname).toBeUndefined();
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
