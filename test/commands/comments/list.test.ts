/**
 * End-to-end tests for `freelo comments list` (R16, spec 0027).
 *
 * Covers:
 *   - Happy paths: default, --page (1-indexed CLI → 0-indexed wire),
 *     --all (multi-page merged), --project (repeatable), --type, --order-by,
 *     --order, --since (client-side post-filter), --since + --all
 *     short-circuit (and no-short-circuit under --order asc).
 *   - Empty list, --request-id round-trip.
 *   - Validation: every typed-error path with `exitCode` assertion
 *     (Calibration §1-2). Includes mutex --page/--all and mutex --since/--page.
 *   - HTTP errors: 401/403/404/429/5xx/network. Each typed error class
 *     triggered and exit code asserted.
 *   - Pagination edge: --all mid-stream 5xx → partial envelope + notice.
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * Test pattern mirrors `test/commands/subtasks/list.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, commentsListHandlers } from '../../msw/handlers.js';

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
    `freelo-comments-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// Realistic comment shapes — used as fixture content in many tests.
const TASK_COMMENT_RECENT = {
  id: 9001,
  uuid: '11111111-1111-1111-1111-111111111111',
  content: 'Fresh comment about the task',
  date_add: '2026-04-25T10:00:00Z',
  date_edited_at: '2026-04-25T10:00:00Z',
  author: { id: 7, fullname: 'Alice' },
  task: { id: 9012, name: 'Wire up the dashboard' },
  tasklist: { id: 50, name: 'Sprint A' },
  project: { id: 11, name: 'Apollo' },
};

const TASK_COMMENT_OLDER = {
  id: 9002,
  uuid: '22222222-2222-2222-2222-222222222222',
  content: 'Older comment',
  date_add: '2026-04-10T10:00:00Z',
  date_edited_at: '2026-04-10T10:00:00Z',
  author: { id: 8, fullname: 'Bob' },
  task: { id: 9013, name: 'Refactor auth' },
  project: { id: 11, name: 'Apollo' },
};

const TASK_COMMENT_ANCIENT = {
  id: 9003,
  uuid: '33333333-3333-3333-3333-333333333333',
  content: 'Ancient comment from before --since cutoff',
  date_add: '2026-03-01T10:00:00Z',
  date_edited_at: '2026-03-01T10:00:00Z',
  author: { id: 9, fullname: 'Carol' },
  task: { id: 9014, name: 'Fix flake' },
  project: { id: 11, name: 'Apollo' },
};

const DOC_COMMENT = {
  id: 9004,
  content: 'Doc comment',
  date_add: '2026-04-20T10:00:00Z',
  date_edited_at: '2026-04-20T10:00:00Z',
  author: { id: 10, fullname: 'Dana' },
  document: { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'Spec.md' },
  project: { id: 22, name: 'Mercury' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo comments list — happy paths', () => {
  it('default invocation: ?p=0, applied_filters {}, exit 0', async () => {
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 2,
          count: 2,
          page: 0,
          per_page: 25,
          data: { comments: [TASK_COMMENT_RECENT, DOC_COMMENT] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        applied_filters: Record<string, unknown>;
        comments: Array<{ id: number }>;
      };
      paging: { page: number; next_cursor: number | null; total: number };
    };
    expect(env.schema).toBe('freelo.comments.list/v1');
    expect(env.data.applied_filters).toEqual({});
    expect(env.data.comments).toHaveLength(2);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.total).toBe(2);
  });

  it('--page 1 (CLI 1-indexed → wire ?p=0): wire request asserted', async () => {
    let observedQuery: string | null = null;
    server.use(
      commentsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { comments: [TASK_COMMENT_RECENT] },
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
    const { exitCode } = await runCli(run, ['comments', 'list', '--page', '1', '--output', 'json']);

    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('p=0');
  });

  it('--page 3 maps to wire ?p=2', async () => {
    let observedQuery: string | null = null;
    server.use(
      commentsListHandlers.paged(
        {
          2: {
            total: 50,
            count: 25,
            page: 2,
            per_page: 25,
            data: { comments: [TASK_COMMENT_RECENT] },
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
      'comments',
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
      commentsListHandlers.paged({
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: { comments: [TASK_COMMENT_RECENT, DOC_COMMENT] },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { comments: [TASK_COMMENT_OLDER] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { comments: Array<{ id: number }> };
      paging: { next_cursor: number | null };
    };
    expect(env.data.comments).toHaveLength(3);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--project repeated: wire encodes projects_ids[]=11&projects_ids[]=22', async () => {
    let observedQuery: string | null = null;
    server.use(
      commentsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { comments: [TASK_COMMENT_RECENT] },
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
      'comments',
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

  it('--type task: wire encodes type=task; applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      commentsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { comments: [TASK_COMMENT_RECENT] },
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
      'comments',
      'list',
      '--type',
      'task',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('type=task');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { type?: string } };
    };
    expect(env.data.applied_filters.type).toBe('task');
  });

  it('--order-by date_edited_at --order asc: wire encodes both, applied_filters echoes', async () => {
    let observedQuery: string | null = null;
    server.use(
      commentsListHandlers.paged(
        {
          0: {
            total: 1,
            count: 1,
            page: 0,
            per_page: 25,
            data: { comments: [TASK_COMMENT_RECENT] },
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
      'comments',
      'list',
      '--order-by',
      'date_edited_at',
      '--order',
      'asc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(observedQuery).toContain('order_by=date_edited_at');
    expect(observedQuery).toContain('order=asc');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { order_by?: string; order?: string } };
    };
    expect(env.data.applied_filters.order_by).toBe('date_edited_at');
    expect(env.data.applied_filters.order).toBe('asc');
  });

  it('--since 2026-04-15: client-side filter drops older items', async () => {
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 3,
          count: 3,
          page: 0,
          per_page: 25,
          data: {
            comments: [TASK_COMMENT_RECENT, DOC_COMMENT, TASK_COMMENT_OLDER],
          },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--since',
      '2026-04-15',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { comments: Array<{ id: number }>; applied_filters: { since?: string } };
      paging: { total: number; per_page: number };
    };
    // TASK_COMMENT_OLDER (2026-04-10) is dropped; the recent two remain.
    expect(env.data.comments.map((c) => c.id)).toEqual([9001, 9004]);
    expect(env.data.applied_filters.since).toBe('2026-04-15');
    // paging reflects the wire response (total: 3, per_page: 25), NOT the
    // post-filtered length — see spec 0027 decision 7.
    expect(env.paging.total).toBe(3);
    expect(env.paging.per_page).toBe(25);
  });

  it('--since + --all: short-circuits when last item on page predates cutoff', async () => {
    // Use distinct fixtures per page so we can detect over-fetching by
    // observing whether page 2's content (which marks "should never be
    // reached") leaks into the merged envelope. This sidesteps any MSW /
    // undici quirks around handler-invocation counting; what matters is
    // the *observable* output.
    const PAGE_2_SENTINEL = {
      id: 99999,
      content: 'PAGE-2-SENTINEL — cutoff was NOT honoured if you see this',
      date_add: '2026-04-26T10:00:00Z',
      date_edited_at: '2026-04-26T10:00:00Z',
      author: { id: 1, fullname: 'Sentinel' },
      task: { id: 1, name: 'sentinel' },
    };
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 100,
          count: 2,
          page: 0,
          per_page: 2,
          data: { comments: [TASK_COMMENT_RECENT, DOC_COMMENT] },
        },
        1: {
          total: 100,
          count: 2,
          page: 1,
          per_page: 2,
          // Page 1 has older comments — last item is ANCIENT (before cutoff).
          data: { comments: [TASK_COMMENT_OLDER, TASK_COMMENT_ANCIENT] },
        },
        2: {
          total: 100,
          count: 1,
          page: 2,
          per_page: 2,
          // The sentinel's date is RECENT (after cutoff). If the cutoff is
          // honoured, the iteration stops before requesting page 2 and this
          // never appears in the output. If the cutoff is NOT honoured, the
          // sentinel leaks into data.comments.
          data: { comments: [PAGE_2_SENTINEL] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--all',
      '--since',
      '2026-04-15',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);

    const env = parseFirstJson(stdout) as {
      data: { comments: Array<{ id: number }> };
      paging: { next_cursor: number | null };
    };
    // RECENT (04-25) >= cutoff: kept
    // DOC (04-20) >= cutoff: kept
    // OLDER (04-10) < cutoff: dropped
    // ANCIENT (03-01) < cutoff: dropped (and triggers cutoffReached for next iter)
    // SENTINEL (04-26): would be kept by --since alone — its absence proves
    //   page 2 was never fetched (the short-circuit fired).
    expect(env.data.comments.map((c) => c.id)).toEqual([9001, 9004]);
    expect(env.data.comments.map((c) => c.id)).not.toContain(99999);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--since + --all + --order asc: short-circuit DISABLED, iterates to exhaustion', async () => {
    // Two pages, the first containing items that ALL predate the cutoff.
    // Under desc order, those would short-circuit the iteration. Under asc,
    // they must NOT — the iteration must continue to page 1 to find the
    // post-cutoff items. We observe this through the merged envelope: if
    // page 1 is reached, its items show up in data.comments.
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 4,
          count: 2,
          page: 0,
          per_page: 2,
          // Under asc, oldest items come first. ANCIENT predates cutoff but
          // we can't short-circuit (more recent items lie ahead).
          data: { comments: [TASK_COMMENT_ANCIENT, TASK_COMMENT_OLDER] },
        },
        1: {
          total: 4,
          count: 2,
          page: 1,
          per_page: 2,
          data: { comments: [DOC_COMMENT, TASK_COMMENT_RECENT] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--all',
      '--since',
      '2026-04-15',
      '--order',
      'asc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    // Both pages fetched: page 1's items (DOC, RECENT) are present. If the
    // short-circuit fired (incorrect under asc), DOC + RECENT would be
    // missing because page 1 would never have been requested.
    const env = parseFirstJson(stdout) as { data: { comments: Array<{ id: number }> } };
    expect(env.data.comments.map((c) => c.id)).toEqual([9004, 9001]);
  });

  it('empty server response: data.comments=[], paging.total=0', async () => {
    server.use(
      commentsListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { comments: [] } },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { comments: unknown[] };
      paging: { total: number };
    };
    expect(env.data.comments).toEqual([]);
    expect(env.paging.total).toBe(0);
  });

  it('human mode (TTY): renders a cli-table3 table', async () => {
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { comments: [TASK_COMMENT_RECENT] },
        },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['comments', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('9001');
    expect(stdout).toContain('Alice');
    expect(stdout).toContain('Apollo');
    expect(stdout).toContain('2026-04-25');
  });

  it('human mode: empty list shows (no comments)', async () => {
    server.use(
      commentsListHandlers.paged({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { comments: [] } },
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['comments', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no comments)');
  });

  it('--request-id <uuid> round-trips into envelope', async () => {
    server.use(
      commentsListHandlers.paged({
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { comments: [TASK_COMMENT_RECENT] },
        },
      }),
    );

    const REQ = '11111111-2222-4333-8444-555555555555';
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
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

describe('freelo comments list — validation', () => {
  it('--project 0: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--project abc: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--type bogus: VALIDATION_ERROR exit 2 (lists valid values)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--type',
      'bogus',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('all');
    expect(stderr).toContain('task');
  });

  it('--order-by bogus: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--order-by',
      'bogus',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--order bogus: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--order',
      'sideways',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--page 0 (1-indexed; first page is --page 1): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
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
      'comments',
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
      'comments',
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

  it('--since not-a-date: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--since',
      'yesterday',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--since 2026-13-99: VALIDATION_ERROR exit 2 (real-date check)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--since',
      '2026-13-99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--since with --page: VALIDATION_ERROR exit 2 (mutex; specific hint about --all)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--since',
      '2026-04-01',
      '--page',
      '2',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('--all');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo comments list — HTTP errors', () => {
  it('GET 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(commentsListHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('GET 403: FORBIDDEN, exit 4', async () => {
    server.use(commentsListHandlers.forbidden());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
  });

  it('GET 404: NOT_FOUND, exit 4', async () => {
    server.use(commentsListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
  });

  it('GET 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(commentsListHandlers.serverError(503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('GET 429 (after retry exhaustion): RATE_LIMITED, exit 6', async () => {
    server.use(commentsListHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('GET network failure: NETWORK_ERROR, exit 5', async () => {
    server.use(commentsListHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'list', '--output', 'json']);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Pagination edge — partial result on mid-stream failure
// ---------------------------------------------------------------------------

describe('freelo comments list — partial pages', () => {
  it('--all fail at page 0 (no successful pages): error propagates, no stdout envelope', async () => {
    server.use(commentsListHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
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
      commentsListHandlers.midStreamError({
        pages: {
          0: {
            total: 3,
            count: 2,
            page: 0,
            per_page: 2,
            data: { comments: [TASK_COMMENT_RECENT, DOC_COMMENT] },
          },
        },
        failPage: 1,
        status: 503,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout) as {
      data: { comments: Array<{ id: number }> };
      notice?: string;
    };
    expect(env.data.comments).toHaveLength(2);
    expect(env.notice).toBeDefined();
    expect(env.notice!).toContain('Partial');
    expect(env.notice!).toContain('page 1');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo comments list — introspect', () => {
  it('lists comments list with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'comments list');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.comments.list/v1');
    expect(entry?.destructive).toBe(false);
  });
});
