/**
 * End-to-end tests for `freelo notifications read` (R28, spec 0040).
 *
 * Mirrors `test/commands/tasks/finish.test.ts` for batch-write structure;
 * adds the `--all-unread` source. Covers:
 *   - Single positional id → single envelope, posted: true, exit 0
 *   - Multiple positional ids → NDJSON envelopes
 *   - --ids "a,b,c" / "a b c" → NDJSON envelopes
 *   - --stdin NDJSON → per-line envelopes with line_index
 *   - --stdin with one bad line and one good → mixed exit 2
 *   - --all-unread → list call + per-id POSTs with source: 'all-unread'
 *   - --all-unread with zero unread → notice envelope, exit 0 (decision 06)
 *   - --dry-run single id → no POST, dry_run + would
 *   - --dry-run with --all-unread → list runs but POSTs do not
 *   - Mutex: positional + --ids → ValidationError exit 2
 *   - Mutex: --ids + --stdin → ValidationError exit 2
 *   - Mutex: --all-unread + positional → ValidationError exit 2
 *   - 404 on single id (multi-id mode) → per-id error env, other ids succeed
 *   - <id 0> → ValidationError exit 2
 *   - <id abc> → ValidationError exit 2
 *
 * Calibration §1: every typed error path asserts the exit code.
 * Calibration §2: each typed error class triggered.
 * Calibration §4: each new try/catch arm in mark.ts (--stdin parse arm,
 *   --stdin POST arm, runIdList POST arm, --all-unread POST arm) covered.
 * Calibration §7: no isInteractive()-gated TTY-prompt branch in this slice
 *   → no `delete process.env.CI` needed. Greps for `isTTY.*true` in this file
 *   yield zero matches.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, notificationsHandlers } from '../../msw/handlers.js';
import { http, HttpResponse } from 'msw';

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
    /* swallow */
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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stream,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: original,
    });
  };
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
    `freelo-notifs-read-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const NOTIF = (id: number, isUnread = true) => ({
  id,
  type: 'task_assigned',
  date_action: '2026-04-25T10:00:00Z',
  is_unread: isUnread,
  is_new: false,
  task: { id: 5, name: 'Ship R28' },
  tasklist: { id: 3, name: 'Backlog' },
  project: { id: 11, name: 'Apollo' },
  comment: null,
  document: null,
  file: null,
  more_comments: false,
  more_users: [],
});

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo notifications read — happy paths', () => {
  it('single positional id: single envelope, posted: true, exit 0', async () => {
    server.use(notificationsHandlers.markReadFor(42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { notification_id: number; posted: boolean };
    };
    expect(env.schema).toBe('freelo.notifications.read/v1');
    expect(env.data.notification_id).toBe(42);
    expect(env.data.posted).toBe(true);
  });

  it('multiple positional ids: NDJSON envelopes, exit 0', async () => {
    server.use(notificationsHandlers.markReadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '43',
      '44',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
    expect(lines.map((l) => (l['data'] as { notification_id: number }).notification_id)).toEqual([
      42, 43, 44,
    ]);
  });

  it('--ids "1,2,3" produces three envelopes', async () => {
    server.use(notificationsHandlers.markReadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--ids',
      '1,2,3',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
  });

  it('--ids "1 2 3" (space separator) also works', async () => {
    server.use(notificationsHandlers.markReadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--ids',
      '1 2 3',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
  });

  it('--stdin NDJSON: three envelopes with line_index', async () => {
    server.use(notificationsHandlers.markReadOk());
    const restore = pipeStdin('{"id": 42}\n{"id": 43}\n{"id": 44}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notifications',
        'read',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect((lines[0]?.data as { line_index: number }).line_index).toBe(0);
      expect((lines[2]?.data as { line_index: number }).line_index).toBe(2);
    } finally {
      restore();
    }
  });

  it('--stdin with one bad JSON line: error env + success env, exit 2', async () => {
    server.use(notificationsHandlers.markReadOk());
    const restore = pipeStdin('{not-json}\n{"id": 43}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notifications',
        'read',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      // One error envelope (line 0) + one success envelope (line 1).
      expect(lines).toHaveLength(2);
      expect((lines[0] as { schema: string }).schema).toBe('freelo.error/v1');
      expect((lines[1] as { schema: string }).schema).toBe('freelo.notifications.read/v1');
    } finally {
      restore();
    }
  });

  it('--all-unread fetches list, then POSTs each id with source: "all-unread"', async () => {
    server.use(
      notificationsHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { notifications: [NOTIF(1001), NOTIF(1002)] },
        },
      }),
      notificationsHandlers.markReadOk(),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--all-unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0]?.data as { notification_id: number }).notification_id).toBe(1001);
    expect((lines[0]?.data as { source: string }).source).toBe('all-unread');
    expect((lines[1]?.data as { notification_id: number }).notification_id).toBe(1002);
  });

  it('--all-unread with zero unread: notice envelope, exit 0 (decision 06)', async () => {
    server.use(
      notificationsHandlers.paged({
        0: {
          total: 0,
          count: 0,
          page: 0,
          per_page: 25,
          data: { notifications: [] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--all-unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      notice: string;
    };
    expect(env.schema).toBe('freelo.notifications.read/v1');
    expect(env.notice).toBe('No unread notifications.');
  });

  it('--dry-run single id: no POST, dry_run + would echoed, exit 0', async () => {
    let postCount = 0;
    server.use(
      http.post(`${API_BASE}/notification/:id/mark-as-read`, () => {
        postCount += 1;
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(postCount).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { would: { method: string; path: string; body: unknown } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/notification/42/mark-as-read');
    expect(env.data.would.body).toEqual({});
  });

  it('--dry-run with --all-unread: list runs, POSTs do NOT', async () => {
    let listCount = 0;
    let postCount = 0;
    server.use(
      http.get(`${API_BASE}/all-notifications`, () => {
        listCount += 1;
        return HttpResponse.json({
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { notifications: [NOTIF(1001), NOTIF(1002)] },
        });
      }),
      http.post(`${API_BASE}/notification/:id/mark-as-read`, () => {
        postCount += 1;
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--all-unread',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(listCount).toBeGreaterThanOrEqual(1);
    expect(postCount).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    for (const l of lines) {
      expect((l as { dry_run?: boolean }).dry_run).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
//  Mutex / validation
// ---------------------------------------------------------------------------

describe('freelo notifications read — mutex / validation', () => {
  it('positional + --ids → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '--ids',
      '43',
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

  it('--ids + --stdin → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--ids',
      '1,2',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
  });

  it('--all-unread + positional → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '--all-unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
  });

  it('<id 0> → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notifications', 'read', '0', '--output', 'json']);

    expect(exitCode).toBe(2);
  });

  it('<id abc> → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notifications', 'read', 'abc', '--output', 'json']);

    expect(exitCode).toBe(2);
  });

  it('--ids "" (empty) → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--ids',
      '   ',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors / batch error envelopes
// ---------------------------------------------------------------------------

describe('freelo notifications read — HTTP errors', () => {
  it('multi-id mode: 404 on first id → per-id error env, others succeed, exit 4', async () => {
    server.use(
      http.post(`${API_BASE}/notification/:id/mark-as-read`, ({ params }) => {
        if (params.id === '42') {
          return HttpResponse.json({ errors: ['Notification not found.'] }, { status: 404 });
        }
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '43',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[0] as { error: { code: string } }).error.code).toBe('NOT_FOUND');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.notifications.read/v1');
  });

  it('single-id mode: 404 → top-level error envelope on stderr, exit 4', async () => {
    server.use(notificationsHandlers.markReadNotFound(42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('--all-unread: 5xx on per-id POST → per-id error env, exit 4 (Calibration §4)', async () => {
    server.use(
      notificationsHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { notifications: [NOTIF(1001), NOTIF(1002)] },
        },
      }),
      http.post(`${API_BASE}/notification/:id/mark-as-read`, ({ params }) => {
        if (params.id === '1001') {
          return HttpResponse.json({ errors: ['oops'] }, { status: 500 });
        }
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--all-unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.notifications.read/v1');
  });

  it('--all-unread: list mid-stream 5xx → partial set processed + error envelope, exit 4 (Calibration §4)', async () => {
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
            data: { notifications: [NOTIF(1001), NOTIF(1002)] },
          });
        }
        return HttpResponse.json({ errors: ['oops'] }, { status: 500 });
      }),
      notificationsHandlers.markReadOk(),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'notifications',
      'read',
      '--all-unread',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Two per-id success envelopes on stdout from the partial set.
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => (l['schema'] as string) === 'freelo.notifications.read/v1')).toBe(
      true,
    );
    // Top-level error envelope on stderr surfaces the underlying list failure.
    const errEnv = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.code).toBe('SERVER_ERROR');
  });

  it('--stdin: 5xx mid-batch → per-line error env, exit 4', async () => {
    server.use(
      http.post(`${API_BASE}/notification/:id/mark-as-read`, ({ params }) => {
        if (params.id === '43') {
          return HttpResponse.json({ errors: ['oops'] }, { status: 500 });
        }
        return HttpResponse.json({ result: 'success' });
      }),
    );
    const restore = pipeStdin('{"id": 42}\n{"id": 43}\n{"id": 44}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notifications',
        'read',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});
