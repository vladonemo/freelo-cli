/**
 * End-to-end tests for `freelo tasks show <id>` (R08, spec 0018).
 *
 * Mirrors `test/commands/tasklists/show.test.ts` (R06). The substantive
 * differences:
 *   - Three side-cars instead of one: `description`, `subtasks`, `projects`.
 *   - `--with projects` does NOT issue a second HTTP call — it projects the
 *     embedded `multi_project_task` block from the detail response (decision 1).
 *   - `--with subtasks` is paginated; the command merges all pages.
 *   - Three `try/catch` arms get hint rewriting on 404 / 403 — spec §3.5 / OQ#3.
 *
 * Calibration §1-2 binding: every typed error path asserts the **exit code**
 * via `freelo.error/v1`'s shape and `process.exit` capture, not just "an
 * error was emitted". §4 binding: each new try/catch arm has at least one
 * test triggering it.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksShowHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasks', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

function captureOutput() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  let firstExitCode: number | undefined;

  const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
    stdout.push(String(chunk));
    return true;
  });
  const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
    stderr.push(String(chunk));
    return true;
  });
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code?: string | number | null) => {
    const c = Number(code ?? 0);
    if (firstExitCode === undefined) firstExitCode = c;
    throw new Error(`EXIT:${c}`);
  });

  return {
    stdout,
    stderr,
    getFirstExitCode: () => firstExitCode,
    restore: () => {
      stdoutSpy.mockRestore();
      stderrSpy.mockRestore();
      exitSpy.mockRestore();
    },
  };
}

async function runCli(
  runFn: (argv: readonly string[]) => Promise<void>,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();
  try {
    await runFn(['node', 'freelo', ...args]);
  } catch {
    /* swallow; exit captured */
  } finally {
    restore();
  }
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: getFirstExitCode() ?? 0,
  };
}

function parseFirstJson(text: string): Record<string, unknown> {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      // try next
    }
  }
  throw new Error(`No JSON in: ${text.slice(0, 200)}`);
}

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-tasks-show-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  await mkdir(testDir, { recursive: true });

  vi.doMock('conf', () => {
    const ConfMock = vi.fn().mockImplementation(() => ({
      get path() {
        return join(testDir, 'config.json');
      },
      has: () => false,
      get store() {
        return {};
      },
      set store(_: unknown) {},
    }));
    return { default: ConfMock };
  });

  vi.resetModules();

  process.env['FREELO_API_KEY'] = 'sk-test';
  process.env['FREELO_EMAIL'] = 'agent@example.cz';

  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
});

afterEach(async () => {
  server.resetHandlers();
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env['FREELO_API_KEY'];
  delete process.env['FREELO_EMAIL'];
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo tasks show — happy paths', () => {
  it('default (no --with) emits envelope with data.task only', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'show', '9001', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task: { id: number; name: string };
        description?: unknown;
        subtasks?: unknown;
        projects?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.tasks.show/v1');
    expect(env.data.task.id).toBe(9001);
    expect(env.data.task.name).toBe('Audit auth flow');
    expect('description' in env.data).toBe(false);
    expect('subtasks' in env.data).toBe(false);
    expect('projects' in env.data).toBe(false);
  });

  it('--with description fetches /task/{id}/description and surfaces data.description', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    const desc = await loadFixture<Record<string, unknown>>('show-description.json');
    server.use(tasksShowHandlers.detailOk(9001, task), tasksShowHandlers.descriptionOk(9001, desc));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { description: { id: number; content: string } };
    };
    expect(env.data.description.id).toBe(55501);
    expect(env.data.description.content).toMatch(/audit the OAuth2 flow/);
  });

  it('--with subtasks single-page returns the merged list', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.subtasksPaged(9001, {
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: {
            subtasks: [
              { id: 8001, task_id: 9001, name: 'Sub A' },
              { id: 8002, task_id: 9001, name: 'Sub B' },
            ],
          },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { subtasks: Array<{ id: number; name: string }> };
    };
    expect(env.data.subtasks).toHaveLength(2);
    expect(env.data.subtasks.map((s) => s.id)).toEqual([8001, 8002]);
  });

  it('--with subtasks multi-page merges items from every page (fetchAllPages)', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    const page0 = await loadFixture<Record<string, unknown>>('show-subtasks-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('show-subtasks-page1.json');

    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.subtasksPaged(9001, {
        0: page0 as never,
        1: page1 as never,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { subtasks: Array<{ id: number }> };
    };
    expect(env.data.subtasks).toHaveLength(3);
    expect(env.data.subtasks.map((s) => s.id)).toEqual([8001, 8002, 8003]);
  });

  it('--with subtasks empty list renders as []', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.subtasksPaged(9001, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { subtasks: unknown[] } };
    expect(env.data.subtasks).toEqual([]);
  });

  it('--with projects (multi-project task) projects the embedded block — no second HTTP call', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001-multi.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'projects',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { projects: { projects: Array<{ id: number; name: string }> } | null };
    };
    expect(env.data.projects).not.toBeNull();
    expect(env.data.projects?.projects).toHaveLength(2);
    expect(env.data.projects?.projects?.[0]?.id).toBe(42);
    expect(env.data.projects?.projects?.[1]?.name).toBe('Sales');
  });

  it('--with projects (single-project task) emits data.projects = null (key present, distinct from absent)', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'projects',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('projects' in env.data).toBe(true);
    expect(env.data['projects']).toBeNull();
  });

  it('--with description,subtasks,projects fires both HTTP side-cars and projects the block', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001-multi.json');
    const desc = await loadFixture<Record<string, unknown>>('show-description.json');
    const page0 = await loadFixture<Record<string, unknown>>('show-subtasks-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('show-subtasks-page1.json');

    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.descriptionOk(9001, desc),
      tasksShowHandlers.subtasksPaged(9001, {
        0: page0 as never,
        1: page1 as never,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description,subtasks,projects',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        task: { id: number };
        description: { id: number };
        subtasks: unknown[];
        projects: { projects: unknown[] } | null;
      };
    };
    expect(env.data.task.id).toBe(9001);
    expect(env.data.description.id).toBe(55501);
    expect(env.data.subtasks).toHaveLength(3);
    expect(env.data.projects?.projects).toHaveLength(2);
  });

  it('--with description,description (duplicate) is treated as one', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    const desc = await loadFixture<Record<string, unknown>>('show-description.json');
    server.use(tasksShowHandlers.detailOk(9001, task), tasksShowHandlers.descriptionOk(9001, desc));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description,description',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { description: { id: number } } };
    expect(env.data.description.id).toBe(55501);
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const REQ = '11111111-2222-4333-8444-555555555555';
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--request-id',
      REQ,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(REQ);
  });

  it('--output human renders header lines and exits 0', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'show', '9001', '--output', 'human']);

    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Task: Audit auth flow \(#9001\)/);
    expect(stdout).toContain('Project:');
    expect(stdout).toContain('Tasklist:');
    expect(stdout).toContain('Worker:   Jane Doe');
    expect(stdout).toContain('Priority: m');
  });

  it('--output human --with subtasks empty renders the (no subtasks) row', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.subtasksPaged(9001, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('SUBTASKS');
    expect(stdout).toContain('(no subtasks)');
  });

  it('--output human --with projects single-project renders the (single-project task) note', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'projects',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('MULTI-PROJECT MEMBERSHIP');
    expect(stdout).toContain('(single-project task)');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors (no HTTP)
// ---------------------------------------------------------------------------

describe('freelo tasks show — validation errors (no HTTP)', () => {
  it('non-numeric <id> exits 2 with ValidationError before any HTTP call', async () => {
    // No MSW handler — if the CLI reaches a fetch, MSW errors as unhandled.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', 'abc', '--output', 'json']);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(stderr.toLowerCase()).toContain('positive integer');
  });

  it('zero <id> exits 2 with ValidationError', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--with bogus exits 2 with hint mentioning description, subtasks, projects', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'bogus',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/description/);
    expect(env.error.hint_next).toMatch(/subtasks/);
    expect(env.error.hint_next).toMatch(/projects/);
  });

  it('--with "" exits 2 with hint to omit the flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Detail-call error paths
// ---------------------------------------------------------------------------

describe('freelo tasks show — detail-call error paths', () => {
  it('404 from /task/{id} maps to FreeloApiError with not-found hint and exit 4', async () => {
    server.use(tasksShowHandlers.detailNotFound(99999));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', '99999', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/task 99999/i);
    expect(env.error.hint_next).toMatch(/not found.*access/i);
  });

  it('403 from /task/{id} maps to FreeloApiError with permission hint and exit 4', async () => {
    server.use(tasksShowHandlers.detailForbidden(7));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', '7', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
    expect(env.error.hint_next).toMatch(/task 7/i);
  });

  it('5xx from /task/{id} exits 4 with passthrough hint (no 404/403 injection)', async () => {
    server.use(tasksShowHandlers.detailServerError(9001, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', '9001', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
    if (env.error.hint_next !== null) {
      expect(env.error.hint_next).not.toMatch(/not found/i);
      expect(env.error.hint_next).not.toMatch(/permission/i);
    }
  });

  it('401 from /task/{id} surfaces as AUTH_EXPIRED with exit 3', async () => {
    server.use(tasksShowHandlers.detailUnauthorized(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'show', '9001', '--output', 'json']);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });
});

// ---------------------------------------------------------------------------
//  Description-call error paths (after detail succeeds)
// ---------------------------------------------------------------------------

describe('freelo tasks show — description-call error paths', () => {
  it('404 on /task/{id}/description (after detail succeeds) exits 4 with description-scoped hint', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task), tasksShowHandlers.descriptionNotFound(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/description.*task 9001/i);
  });

  it('403 on /task/{id}/description exits 4 with permission hint mentioning description', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.descriptionForbidden(9001),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
    expect(env.error.hint_next).toMatch(/description/i);
  });

  it('5xx on /task/{id}/description exits 4 as SERVER_ERROR', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.descriptionServerError(9001, 502),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'description',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(502);
  });
});

// ---------------------------------------------------------------------------
//  Subtasks-call error paths (after detail succeeds)
// ---------------------------------------------------------------------------

describe('freelo tasks show — subtasks-call error paths', () => {
  it('404 on /task/{id}/subtasks exits 4 with subtasks-scoped hint', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task), tasksShowHandlers.subtasksNotFound(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/subtasks.*task 9001/i);
  });

  it('403 on /task/{id}/subtasks exits 4 with permission hint mentioning subtasks', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    server.use(tasksShowHandlers.detailOk(9001, task), tasksShowHandlers.subtasksForbidden(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
    expect(env.error.hint_next).toMatch(/subtasks/i);
  });

  it('5xx mid-stream on /task/{id}/subtasks?p=1 unwraps PartialPagesError to underlying FreeloApiError, exit 4', async () => {
    const task = await loadFixture<Record<string, unknown>>('show-task-9001.json');
    const page0 = await loadFixture<Record<string, unknown>>('show-subtasks-page0.json');

    server.use(
      tasksShowHandlers.detailOk(9001, task),
      tasksShowHandlers.subtasksMidStreamError({
        taskId: 9001,
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'show',
      '9001',
      '--with',
      'subtasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(500);
  });
});

// ---------------------------------------------------------------------------
//  Regression — issue #105 / spec 0059: comments[].files[] without `id`
//
//  `TaskDetailSchema` backs `tasks show` as well as `tasks edit` / `tasks move`,
//  so the same wire shape that broke the edit lookup broke `show` too.
//  Fixture is synthetic (spec 0059 §9).
// ---------------------------------------------------------------------------

describe('freelo tasks show — comments[].files[] without `id` (issue #105)', () => {
  it('renders a task whose comment attachment carries no `id` — exit 0', async () => {
    const detail = await loadFixture<Record<string, unknown>>(
      'show-task-9020-comment-file-no-id.json',
    );
    server.use(tasksShowHandlers.detailOk(9020, detail));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'show', '9020', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task: { comments: Array<{ files: Array<Record<string, unknown>> }> } };
    };
    const files = env.data.task.comments[0]!.files;
    expect(files[0]).toMatchObject({ uuid: 'file-uuid-aaaa-0001' });
    expect('id' in files[0]!).toBe(false);
    expect(files[1]).toMatchObject({ id: 66001 });
  });
});
