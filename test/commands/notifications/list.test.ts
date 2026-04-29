/**
 * End-to-end tests for `freelo notifications list` (R28, spec 0040).
 *
 * Mirrors `test/commands/files/list.test.ts` byte-for-byte modulo
 * URL/handler/schema discriminant. Covers:
 *   - Default invocation (?p=0, applied_filters {})
 *   - --unread → only_unread=1 on the wire (string; live API ignores boolean)
 *   - --project (repeatable) → projects_ids[]
 *   - --type (repeatable) → notification_types[]
 *   - --page N (1-indexed CLI → 0-indexed wire)
 *   - --all (multi-page merge)
 *   - --page + --all → ValidationError exit 2
 *   - Validation: --page non-positive → ValidationError exit 2
 *   - Validation: --project non-positive → ValidationError exit 2
 *   - Validation: --type empty → ValidationError exit 2
 *   - 401 → FreeloApiError exit 1, error envelope on stderr
 *   - --all with mid-stream 5xx → partial envelope + notice + exit 1
 *
 * Calibration §1: every typed error path asserts the exit code through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class triggered.
 * Calibration §7: no isInteractive()-gated TTY-prompt branch in this
 * command, so no `delete process.env.CI` needed.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, notificationsHandlers } from '../../msw/handlers.js';

const API_BASE = 'https://api.freelo.io/v1';

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
    `freelo-notifs-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const NOTIF_A = {
  id: 1001,
  type: 'task_assigned',
  date_action: '2026-04-25T10:00:00Z',
  author: { id: 7, fullname: 'Alice' },
  who: { id: 8, fullname: 'Bob' },
  is_unread: true,
  is_new: true,
  task: { id: 5, name: 'Ship R28' },
  tasklist: { id: 3, name: 'Backlog' },
  project: { id: 11, name: 'Apollo' },
  comment: null,
  document: null,
  file: null,
  more_comments: false,
  more_users: [],
};

const NOTIF_B = {
  id: 1002,
  type: 'comment_created',
  date_action: '2026-04-24T09:00:00Z',
  author: { id: 8, fullname: 'Bob' },
  who: { id: 7, fullname: 'Alice' },
  is_unread: false,
  is_new: false,
  task: { id: 5, name: 'Ship R28' },
  tasklist: { id: 3, name: 'Backlog' },
  project: { id: 11, name: 'Apollo' },
  comment: { id: 99 },
  document: null,
  file: null,
  more_comments: false,
  more_users: [],
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo notifications list — happy paths', () => {
  it('default invocation: ?p=0, applied_filters {}, exit 0', async () => {
    server.use(
      notificationsHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { notifications: [NOTIF_A, NOTIF_B] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['notifications', 'list', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        applied_filters: Record<string, unknown>;
        items: Array<{ id: number }>;
      };
      paging: { page: number; next_cursor: number | null; total: number };
    };
    expect(env.schema).toBe('freelo.notifications.list/v1');
    expect(env.data.applied_filters).toEqual({});
    expect(env.data.items).toHaveLength(2);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.total).toBe(2);
  });

  it('--unread sends only_unread=1 on the wire (string; live API ignores boolean true)', async () => {
    let observedQuery: string | null = null;
    server.use(
      notificationsHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { notifications: [NOTIF_A] },
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
      'notifications',
      'list',
      '--unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('only_unread=1');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { only_unread?: boolean } };
    };
    expect(env.data.applied_filters.only_unread).toBe(true);
  });

  it('--project (repeatable) emits projects_ids[]', async () => {
    let observedQuery: string | null = null;
    server.use(
      notificationsHandlers.paged(
        {
          0: {
            total: 0,
            count: 0,
            page: 0,
            per_page: 25,
            data: { notifications: [] },
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
      'notifications',
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

  it('--type (repeatable) emits notification_types[]', async () => {
    let observedQuery: string | null = null;
    server.use(
      notificationsHandlers.paged(
        {
          0: {
            total: 0,
            count: 0,
            page: 0,
            per_page: 25,
            data: { notifications: [] },
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
      'notifications',
      'list',
      '--type',
      'task_assigned',
      '--type',
      'comment_created',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('notification_types%5B%5D=task_assigned');
    expect(observedQuery).toContain('notification_types%5B%5D=comment_created');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { types?: string[] } };
    };
    expect(env.data.applied_filters.types).toEqual(['task_assigned', 'comment_created']);
  });

  it('--page 3 maps to wire ?p=2', async () => {
    let observedQuery: string | null = null;
    server.use(
      notificationsHandlers.paged(
        {
          2: {
            total: 50,
            count: 25,
            page: 2,
            per_page: 25,
            data: { notifications: [NOTIF_A] },
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
      'notifications',
      'list',
      '--page',
      '3',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=2');
    const env = parseFirstJson(stdout) as {
      paging: { page: number };
    };
    expect(env.paging.page).toBe(2);
  });

  it('--all iterates pages and merges into one envelope', async () => {
    server.use(
      notificationsHandlers.paged({
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: { notifications: [NOTIF_A, NOTIF_B] },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { notifications: [{ ...NOTIF_A, id: 1003 }] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { items: Array<{ id: number }> };
      paging: { total: number };
    };
    expect(env.data.items).toHaveLength(3);
    expect(env.paging.total).toBe(3);
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo notifications list — validation', () => {
  it('--page and --all together → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--page',
      '1',
      '--all',
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
  });

  it('--page 0 → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--page',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--page abc → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project 0 → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--type "" → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--type',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo notifications list — HTTP errors', () => {
  it('401 → AUTH_EXPIRED, exit 3, error envelope on stderr', async () => {
    server.use(notificationsHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notifications', 'list', '--output', 'json']);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('AUTH_EXPIRED');
    expect(env.error.http_status).toBe(401);
  });

  it('--all mid-stream 5xx → partial envelope on stdout + error envelope on stderr, exit 4 (Calibration §4)', async () => {
    server.use(
      http.get(`${API_BASE}/all-notifications`, ({ request }) => {
        const u = new URL(request.url);
        const p = Number(u.searchParams.get('p') ?? '0');
        if (p === 0) {
          return HttpResponse.json({
            total: 4,
            count: 2,
            page: 0,
            per_page: 2,
            data: { notifications: [NOTIF_A, NOTIF_B] },
          });
        }
        return HttpResponse.json({ errors: ['Internal server error.'] }, { status: 500 });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'notifications',
      'list',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Partial envelope with notice on stdout.
    const partial = parseFirstJson(stdout) as {
      schema: string;
      data: { items: Array<{ id: number }> };
      notice: string;
    };
    expect(partial.schema).toBe('freelo.notifications.list/v1');
    expect(partial.data.items).toHaveLength(2);
    expect(partial.notice).toContain('Partial result');
    // Error envelope on stderr.
    const errEnv = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string };
    };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.code).toBe('SERVER_ERROR');
  });

  it('500 → SERVER_ERROR, exit 4, error envelope on stderr', async () => {
    server.use(notificationsHandlers.serverError(500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notifications', 'list', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(500);
  });
});
