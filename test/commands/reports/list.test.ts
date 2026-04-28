/**
 * End-to-end tests for `freelo reports list` (R21, spec 0033).
 *
 * Covers:
 *   - Happy paths: default, --page (1-indexed CLI → 0-indexed wire),
 *     --all (multi-page merged), --task / --project / --worker (repeatable),
 *     --from / --to (server-side date_reported_range filter),
 *     --request-id round-trip, empty list.
 *   - Validation: every typed-error path with `exitCode` assertion
 *     (Calibration §1-2). Includes mutex --page/--all, non-positive ints,
 *     non-ISO dates.
 *   - HTTP errors: 401/403/404/429/5xx/network. Each typed error class
 *     triggered and exit code asserted.
 *   - Schema-validation: malformed wire row → FreeloApiError VALIDATION_ERROR.
 *   - Pagination edge: --all mid-stream 5xx → partial envelope + notice.
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * Test pattern mirrors `test/commands/comments/list.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, workReportsListHandlers } from '../../msw/handlers.js';

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
    `freelo-reports-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// Realistic work-report shapes — used as fixture content in many tests.
const REPORT_RECENT = {
  id: 7001,
  date_add: '2026-04-25T10:00:00Z',
  date_reported: '2026-04-25',
  date_edited_at: '2026-04-25T10:30:00Z',
  note: 'Wired up the dashboard feature flag',
  minutes: 90,
  cost: { amount: '1500', currency: 'CZK' as const },
  author: { id: 7, fullname: 'Alice' },
  worker: { id: 7, fullname: 'Alice' },
  task: { id: 9012, name: 'Wire up the dashboard' },
  tasklist: { id: 50, name: 'Sprint A' },
  project: { id: 11, name: 'Apollo' },
};

const REPORT_OLDER = {
  id: 7002,
  date_add: '2026-04-10T08:00:00Z',
  date_reported: '2026-04-10',
  note: 'Refactor auth helper',
  minutes: 45,
  cost: { amount: '800', currency: 'CZK' as const },
  author: { id: 8, fullname: 'Bob' },
  worker: { id: 8, fullname: 'Bob' },
  task: { id: 9013, name: 'Refactor auth' },
  project: { id: 11, name: 'Apollo' },
};

const REPORT_TASKLESS = {
  id: 7003,
  date_add: '2026-04-20T09:00:00Z',
  date_reported: '2026-04-20',
  note: null,
  minutes: 30,
  worker: { id: 9 }, // fullname missing — exercises the renderer's fallback
  task: null,
  project: { id: 22, name: 'Mercury' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo reports list — happy paths', () => {
  it('default invocation: ?p=0, applied_filters {}, exit 0', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { reports: [REPORT_RECENT, REPORT_OLDER] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        applied_filters: Record<string, unknown>;
        reports: Array<{ id: number }>;
      };
      paging: { page: number; next_cursor: number | null; total: number };
    };
    expect(env.schema).toBe('freelo.reports.list/v1');
    expect(env.data.applied_filters).toEqual({});
    expect(env.data.reports).toHaveLength(2);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.total).toBe(2);
  });

  it('--page 1 (CLI 1-indexed → wire ?p=0): wire request asserted', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['reports', 'list', '--page', '1', '--output', 'json']);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=0');
  });

  it('--page 3 maps to wire ?p=2', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          2: {
            total: 50,
            count: 25,
            page: 2,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--page',
      '3',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=2');
    const env = parseFirstJson(stdout) as { paging: { page: number } };
    expect(env.paging.page).toBe(2);
  });

  it('--all: merges across multiple pages, paging.next_cursor=null at end', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: { reports: [REPORT_RECENT, REPORT_TASKLESS] },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { reports: [REPORT_OLDER] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { reports: Array<{ id: number }> };
      paging: { next_cursor: number | null };
    };
    expect(env.data.reports).toHaveLength(3);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--task repeated: wire encodes tasks_ids[]=9012&tasks_ids[]=9013', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--task',
      '9012',
      '--task',
      '9013',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('tasks_ids%5B%5D=9012');
    expect(observedQuery).toContain('tasks_ids%5B%5D=9013');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { tasks?: number[] } };
    };
    expect(env.data.applied_filters.tasks).toEqual([9012, 9013]);
  });

  it('--project repeated: wire encodes projects_ids[]=11&projects_ids[]=22; applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--project',
      '11',
      '--project',
      '22',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('projects_ids%5B%5D=11');
    expect(observedQuery).toContain('projects_ids%5B%5D=22');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { projects?: number[] } };
    };
    expect(env.data.applied_filters.projects).toEqual([11, 22]);
  });

  it('--worker: wire encodes users_ids[]=7; applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--worker',
      '7',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('users_ids%5B%5D=7');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { workers?: number[] } };
    };
    expect(env.data.applied_filters.workers).toEqual([7]);
  });

  it('--from / --to: wire encodes date_reported_range[date_from] / [date_to]; applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--from',
      '2026-04-01',
      '--to',
      '2026-04-30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('date_reported_range%5Bdate_from%5D=2026-04-01');
    expect(observedQuery).toContain('date_reported_range%5Bdate_to%5D=2026-04-30');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { from?: string; to?: string } };
    };
    expect(env.data.applied_filters.from).toBe('2026-04-01');
    expect(env.data.applied_filters.to).toBe('2026-04-30');
  });

  it('all filters together: each lands on the wire, all echo into applied_filters', async () => {
    let observedQuery: string | null = null;
    server.use(
      workReportsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { reports: [REPORT_RECENT] },
          },
        },
        {
          onRequest: (req) => {
            observedQuery = new URL(req.url).search;
          },
        },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--task',
      '9012',
      '--project',
      '11',
      '--worker',
      '7',
      '--from',
      '2026-04-01',
      '--to',
      '2026-04-30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('tasks_ids%5B%5D=9012');
    expect(observedQuery).toContain('projects_ids%5B%5D=11');
    expect(observedQuery).toContain('users_ids%5B%5D=7');
    expect(observedQuery).toContain('date_reported_range%5Bdate_from%5D=2026-04-01');
    expect(observedQuery).toContain('date_reported_range%5Bdate_to%5D=2026-04-30');
    const env = parseFirstJson(stdout) as {
      data: {
        applied_filters: {
          tasks?: number[];
          projects?: number[];
          workers?: number[];
          from?: string;
          to?: string;
        };
      };
    };
    expect(env.data.applied_filters).toEqual({
      tasks: [9012],
      projects: [11],
      workers: [7],
      from: '2026-04-01',
      to: '2026-04-30',
    });
  });

  it('empty server response: data.reports=[], paging.total=0', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { reports: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { reports: unknown[] };
      paging: { total: number };
    };
    expect(env.data.reports).toEqual([]);
    expect(env.paging.total).toBe(0);
  });

  it('human mode (TTY): renders a cli-table3 table with relevant columns', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { reports: [REPORT_RECENT] },
        },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['reports', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('7001');
    expect(stdout).toContain('Alice');
    expect(stdout).toContain('Apollo');
    expect(stdout).toContain('2026-04-25');
    expect(stdout).toContain('90');
  });

  it('human mode: empty list shows (no work reports)', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { reports: [] } },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['reports', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no work reports)');
  });

  it('human mode: worker without fullname falls back to numeric id', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { reports: [REPORT_TASKLESS] },
        },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['reports', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    // Worker.id 9 with no fullname → "9" should appear in the worker column.
    expect(stdout).toContain(' 9 ');
    // Task null → "-" placeholder column (renderer formatRefName fallback).
    expect(stdout).toContain('Mercury');
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    server.use(
      workReportsListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { reports: [REPORT_RECENT] },
        },
      }),
    );

    const REQ = '11111111-2222-4333-8444-555555555555';
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--request-id',
      REQ,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(REQ);
  });
});

// ---------------------------------------------------------------------------
//  Validation (every error path → exit 2)
// ---------------------------------------------------------------------------

describe('freelo reports list — validation', () => {
  it('--task 0: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--task',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--task abc: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--task',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--project -1: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--project',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--worker xyz: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--worker',
      'xyz',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--from 2026/04/01: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--from',
      '2026/04/01',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--to 2026-13-99: VALIDATION_ERROR exit 2 (real-date check)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--to',
      '2026-13-99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page 0 (1-indexed; first page is --page 1): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--page',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page abc: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page and --all together: VALIDATION_ERROR exit 2 (mutex)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
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

describe('freelo reports list — HTTP errors', () => {
  it('GET 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(workReportsListHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('GET 403: FORBIDDEN, exit 4', async () => {
    server.use(workReportsListHandlers.forbidden());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
  });

  it('GET 404: NOT_FOUND, exit 4', async () => {
    server.use(workReportsListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
  });

  it('GET 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(workReportsListHandlers.serverError(503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('GET 429 (after retry exhaustion): RATE_LIMITED, exit 6', async () => {
    server.use(workReportsListHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('GET network failure: NETWORK_ERROR, exit 5', async () => {
    server.use(workReportsListHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });

  it('GET 200 with malformed body: VALIDATION_ERROR (FreeloApiError), exit 4', async () => {
    server.use(workReportsListHandlers.malformed());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Pagination edge — partial result on mid-stream failure
// ---------------------------------------------------------------------------

describe('freelo reports list — partial pages', () => {
  it('--all fail at page 0 (no successful pages): error propagates, no stdout envelope', async () => {
    server.use(workReportsListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stdout).toBe('');
  });

  it('--all mid-stream 5xx after page 0 success: partial envelope on stdout + notice + exit 4', async () => {
    server.use(
      workReportsListHandlers.midStreamError({
        pages: {
          0: {
            total: 3,
            count: 2,
            page: 0,
            per_page: 2,
            data: { reports: [REPORT_RECENT, REPORT_TASKLESS] },
          },
        },
        failPage: 1,
        status: 503,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout) as {
      data: { reports: Array<{ id: number }> };
      notice?: string;
    };
    expect(env.data.reports).toHaveLength(2);
    expect(env.notice).toBeDefined();
    expect(env.notice!).toContain('Partial');
    expect(env.notice!).toContain('page 1');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo reports list — introspect', () => {
  it('lists reports list with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'reports list');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.reports.list/v1');
    expect(entry?.destructive).toBe(false);
  });
});
