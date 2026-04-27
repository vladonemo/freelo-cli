/**
 * End-to-end tests for `freelo subtasks list --task <id>` (R14, spec 0025).
 *
 * Covers:
 *   - Happy paths: single page (default --page 0), --page N, --all (multi-page merged).
 *   - Empty subtasks list.
 *   - Validation: --task required / non-numeric / zero, --page non-negative,
 *     --page + --all mutex.
 *   - HTTP errors: 401/403/404/429/5xx/network. Each typed error class triggered
 *     and exit code asserted (Calibration §1-2).
 *   - Pagination edge: --all mid-stream 5xx after one successful page → partial
 *     envelope + `notice` + exit derived from inner cause.
 *   - Introspect entry shows `output_schema` and `destructive: false`.
 *
 * Test pattern mirrors `test/commands/tasks/show.test.ts` and
 * `test/commands/tasks/delete.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksShowHandlers } from '../../msw/handlers.js';

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
    `freelo-subtasks-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// Realistic subtask shape — used as fixture content in many tests.
const SMART_SUBTASK = {
  id: 5001,
  task_id: 9012,
  name: 'Smart subtask 1',
  date_add: '2026-04-01T10:00:00Z',
  due_date: '2026-05-01T00:00:00Z',
  count_comments: 0,
  count_subtasks: 0,
  worker: { id: 7, fullname: 'Alice' },
  state: { id: 1, state: 'active' as const },
};

const SIMPLE_SUBTASK = {
  id: 5002,
  task_id: 9012,
  name: 'Simple checklist row',
  date_add: '2026-04-01T10:00:00Z',
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo subtasks list — happy paths', () => {
  it('single page (default --page 0): JSON envelope, paging.next_cursor=null, exit 0', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { subtasks: [SMART_SUBTASK, SIMPLE_SUBTASK] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; subtasks: Array<{ id: number; name: string }> };
      paging: { page: number; per_page: number; total: number; next_cursor: number | null };
    };
    expect(env.schema).toBe('freelo.subtasks.list/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.subtasks).toHaveLength(2);
    expect(env.data.subtasks[0]!.id).toBe(5001);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.total).toBe(2);
  });

  it('--page 1: envelope reflects page 1', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: { total: 50, count: 25, page: 0, per_page: 25, data: { subtasks: [SMART_SUBTASK] } },
        1: { total: 50, count: 25, page: 1, per_page: 25, data: { subtasks: [SIMPLE_SUBTASK] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--page',
      '1',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { subtasks: Array<{ id: number }> };
      paging: { page: number };
    };
    expect(env.paging.page).toBe(1);
    expect(env.data.subtasks[0]!.id).toBe(5002);
  });

  it('--all: merges across multiple pages, paging.next_cursor=null at end, exit 0', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: { subtasks: [SMART_SUBTASK, SIMPLE_SUBTASK] },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { subtasks: [{ ...SMART_SUBTASK, id: 5003, name: 'page-1 row' }] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { subtasks: Array<{ id: number }> };
      paging: { next_cursor: number | null; total: number };
    };
    expect(env.data.subtasks).toHaveLength(3);
    expect(env.data.subtasks.map((s) => s.id)).toEqual([5001, 5002, 5003]);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('empty subtasks list: data.subtasks=[], paging.total=0, exit 0', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { subtasks: unknown[] };
      paging: { total: number };
    };
    expect(env.data.subtasks).toEqual([]);
    expect(env.paging.total).toBe(0);
  });

  it('human mode: renders table with smart subtask data', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: { total: 1, count: 1, page: 0, per_page: 25, data: { subtasks: [SMART_SUBTASK] } },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('5001');
    expect(stdout).toContain('Smart subtask 1');
    expect(stdout).toContain('Alice');
    expect(stdout).toContain('active');
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: { total: 1, count: 1, page: 0, per_page: 25, data: { subtasks: [SMART_SUBTASK] } },
      }),
    );

    const REQ = '11111111-2222-4333-8444-555555555555';
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--request-id',
      REQ,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(REQ);
  });

  it('human mode: empty list shows (no subtasks)', async () => {
    server.use(
      tasksShowHandlers.subtasksPaged(9012, {
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { subtasks: [] } },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no subtasks)');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo subtasks list — validation', () => {
  it('missing --task: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['subtasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--task non-numeric: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--task zero: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--task negative: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '-5',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page negative: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--page',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page and --all together: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--page',
      '1',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('mutually exclusive');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo subtasks list — HTTP errors', () => {
  it('GET 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(tasksShowHandlers.subtasksForbidden(9012)); // we'll override this immediately
    server.resetHandlers();
    server.use(
      // 401 specifically:
      // (avoid using the show handler's 'forbidden' which is 403)
      // Use a one-off http handler directly.
      tasksShowHandlers.detailUnauthorized(9012), // for any /task/{id} fallback
      tasksShowHandlers.subtasksForbidden(9012),
    );
    server.resetHandlers();
    // Cleanest path: use the existing 401 helper if any. Inline:
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012/subtasks`, () =>
        HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('GET 403: FORBIDDEN, exit 4, hint mentions permission', async () => {
    server.use(tasksShowHandlers.subtasksForbidden(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
  });

  it('GET 404: NOT_FOUND, exit 4, hint mentions task not found', async () => {
    server.use(tasksShowHandlers.subtasksNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
  });

  it('GET 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(tasksShowHandlers.subtasksServerError(9012, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('GET 429 (after retry exhaustion): RATE_LIMITED, exit 6', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get(
        `https://api.freelo.io/v1/task/9012/subtasks`,
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
          }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('GET network failure: NETWORK_ERROR, exit 5', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(http.get(`https://api.freelo.io/v1/task/9012/subtasks`, () => HttpResponse.error()));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Pagination edge — partial result on mid-stream failure
// ---------------------------------------------------------------------------

describe('freelo subtasks list — partial pages', () => {
  it('--all fail at page 0 (no successful pages): error propagates with subtasks-scoped hint, exit 4', async () => {
    // No pages succeed → fetchAllPages re-throws the underlying error
    // unchanged (NOT a PartialPagesError). Exercises the second `throw` arm
    // in runAll() — `throw rewriteSubtasksHint(err, taskId)`.
    server.use(tasksShowHandlers.subtasksNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
    // No partial envelope on stdout — nothing was fetched.
    expect(stdout).toBe('');
  });

  it('--all mid-stream 5xx after page 0 success: partial envelope on stdout + notice + exit 4', async () => {
    server.use(
      tasksShowHandlers.subtasksMidStreamError({
        taskId: 9012,
        pages: {
          0: {
            total: 3,
            count: 2,
            page: 0,
            per_page: 2,
            data: { subtasks: [SMART_SUBTASK, SIMPLE_SUBTASK] },
          },
        },
        failPage: 1,
        status: 503,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'list',
      '--task',
      '9012',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Stdout carries the partial result envelope with notice.
    const env = parseFirstJson(stdout) as {
      data: { subtasks: Array<{ id: number }> };
      notice?: string;
    };
    expect(env.data.subtasks).toHaveLength(2);
    expect(env.notice).toBeDefined();
    expect(env.notice!).toContain('Partial');
    expect(env.notice!).toContain('page 1');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo subtasks list — introspect', () => {
  it('lists subtasks list with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'subtasks list');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.subtasks.list/v1');
    expect(entry?.destructive).toBe(false);
  });
});
