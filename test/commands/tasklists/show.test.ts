/**
 * End-to-end tests for `freelo tasklists show <id>` (R06, spec 0016).
 *
 * Mirrors the harness from `test/commands/projects/show.test.ts` (R04). The
 * substantive differences:
 *   - Side-car endpoint returns a bare array (NOT paginated) — see decision 1.
 *   - Side-car URL needs the `project_id` from the detail response — see
 *     decision 2.
 *   - Both call sites get hint rewriting on 404 / 403 — spec §3.5 / OQ#3.
 *
 * Calibration §1-2 binding: every typed error path asserts the **exit code**
 * via `freelo.error/v1`'s shape and `process.exit` capture, not just "an
 * error was emitted".
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasklistShowHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasklists', name);
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

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-tasklists-show-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasklists show — happy path', () => {
  it('emits freelo.tasklists.show/v1 envelope with tasklist data, no assignable_workers when --with omitted', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(tasklistShowHandlers.detailOk(314, tasklist));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { tasklist: { id: number; project_id: number }; assignable_workers?: unknown };
    };
    expect(env.schema).toBe('freelo.tasklists.show/v1');
    expect(env.data.tasklist.id).toBe(314);
    expect(env.data.tasklist.project_id).toBe(42);
    expect('assignable_workers' in env.data).toBe(false);
  });

  it('with --with assignable-workers, fetches the side-car using project_id from the detail response', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    const workers = await loadFixture<Array<{ id: number; fullname: string }>>(
      'show-assignable-workers.json',
    );

    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      // Note: project_id (42) was read from the detail response — the user
      // never supplied it on the command line. Decision 2.
      tasklistShowHandlers.assignableWorkersOk(42, 314, workers),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        tasklist: { id: number; project_id: number };
        assignable_workers: { id: number; fullname: string }[];
      };
    };
    expect(env.schema).toBe('freelo.tasklists.show/v1');
    expect(env.data.assignable_workers).toHaveLength(3);
    expect(env.data.assignable_workers.map((w) => w.id)).toEqual([9, 17, 23]);
  });

  it('with --with assignable-workers, empty list renders as empty array (key present)', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersOk(42, 314, []),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { assignable_workers: unknown[] };
    };
    expect(env.data.assignable_workers).toEqual([]);
  });

  it('--with assignable-workers,assignable-workers (duplicate) is treated as one', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    const workers = await loadFixture<Array<{ id: number; fullname: string }>>(
      'show-assignable-workers.json',
    );
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersOk(42, 314, workers),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stdout } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers,assignable-workers',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { assignable_workers: unknown[] };
    };
    expect(env.data.assignable_workers).toHaveLength(3);
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(tasklistShowHandlers.detailOk(314, tasklist));

    const { run } = await import('../../../src/bin/freelo.js');
    // UUID v4: third segment starts with `4`, fourth starts with 8/9/a/b.
    const REQ = '11111111-2222-4333-8444-555555555555';
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
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
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(tasklistShowHandlers.detailOk(314, tasklist));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Tasklist:.*Backend QA.*#314/);
    expect(stdout).toContain('Project:  42');
  });

  it('--output human with --with assignable-workers renders the workers table', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    const workers = await loadFixture<Array<{ id: number; fullname: string }>>(
      'show-assignable-workers.json',
    );
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersOk(42, 314, workers),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ASSIGNABLE WORKERS');
    expect(stdout).toContain('Owner Name');
    expect(stdout).toContain('Jane Doe');
    expect(stdout).toContain('Karel Novak');
  });

  it('--output human with --with assignable-workers and an empty list renders the no-workers row', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersOk(42, 314, []),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ASSIGNABLE WORKERS');
    expect(stdout).toContain('(no assignable workers)');
  });

  it('--output human handles a tasklist with no name (R05.5 hardening — fullname-style nullability)', async () => {
    // Server omits `name`; renderer falls back to empty string for the label.
    const tasklist = {
      id: 314,
      project_id: 42,
      date_add: '2026-01-15T09:00:00Z',
      date_edited_at: '2026-04-20T11:23:45Z',
      tasks: [],
    };
    server.use(tasklistShowHandlers.detailOk(314, tasklist));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('#314');
    // Tasklist label is empty when name is missing.
    expect(stdout).toMatch(/Tasklist:\s+\(#314\)/);
  });
});

describe('freelo tasklists show — validation errors (no HTTP)', () => {
  it('non-numeric <id> exits 2 with ValidationError before any HTTP call', async () => {
    // No MSW handler registered — if the CLI reaches a fetch, MSW errors as
    // unhandled and the test fails. That is the assertion: no HTTP fired.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      'abc',
      '--output',
      'json',
    ]);

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
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'show', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--with bogus exits 2 with hint mentioning assignable-workers', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
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
    expect(env.error.hint_next).toMatch(/assignable-workers/);
  });

  it('--with "" exits 2 with hint to omit the flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
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

describe('freelo tasklists show — detail-call error paths', () => {
  it('404 from /tasklist/{id} maps to FreeloApiError with not-found hint and exit 4', async () => {
    server.use(tasklistShowHandlers.detailNotFound(99999));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '99999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/tasklist 99999/i);
    expect(env.error.hint_next).toMatch(/not found.*access/i);
  });

  it('403 from /tasklist/{id} maps to FreeloApiError with permission hint and exit 4', async () => {
    server.use(tasklistShowHandlers.detailForbidden(7));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'show', '7', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
    expect(env.error.hint_next).toMatch(/tasklist 7/i);
  });

  it('5xx from /tasklist/{id} exits 4 with passthrough hint (no 404/403 injection)', async () => {
    server.use(tasklistShowHandlers.detailServerError(314, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
    if (env.error.hint_next !== null) {
      expect(env.error.hint_next).not.toMatch(/not found/i);
      expect(env.error.hint_next).not.toMatch(/permission/i);
    }
  });

  it('401 from /tasklist/{id} surfaces as AUTH_EXPIRED with exit 3', async () => {
    server.use(tasklistShowHandlers.detailUnauthorized(314));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });
});

describe('freelo tasklists show — assignable-workers error paths', () => {
  it('404 on /assignable-workers (after detail succeeds) exits 4 with hint mentioning the side-car', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersNotFound(42, 314),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/assignable workers.*tasklist 314/i);
  });

  it('403 on /assignable-workers (after detail succeeds) exits 4 with permission hint', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersForbidden(42, 314),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
    expect(env.error.hint_next).toMatch(/assignable workers/i);
  });

  it('5xx on /assignable-workers (after detail succeeds) exits 4 as SERVER_ERROR', async () => {
    const tasklist = await loadFixture<Record<string, unknown>>('show-tasklist-314.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklist),
      tasklistShowHandlers.assignableWorkersServerError(42, 314, 502),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'show',
      '314',
      '--with',
      'assignable-workers',
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
