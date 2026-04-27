/**
 * End-to-end tests for `freelo tasks move` (R12, spec 0022).
 *
 * Covers:
 *   - Happy paths (cross-tasklist same project, cross-project, idempotent skip).
 *   - Dry-run shapes (with and without `would`).
 *   - `--to-project` post-hoc assertion (match → no notice; mismatch → notice).
 *   - Validation: `<id>`, `--to-tasklist`, `--to-project`.
 *   - HTTP errors on pre-check and POST: 401/403/404/429/5xx/network.
 *   - Edge cases: deleted-task pre-check refusal; refresh-GET-fails post-move
 *     emits success-with-notice + `task: null`; pre-check task with no
 *     tasklist ref still proceeds.
 *   - Introspect entry shows the new command.
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class (`ValidationError`, `FreeloApiError`,
 * `NetworkError`, `RateLimitedError`) has a triggering test.
 * Calibration §4: the refresh-GET catch arm has a dedicated test row.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, tasksShowHandlers, tasksMoveHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-move-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks move — happy paths', () => {
  it('cross-tasklist within same project: JSON envelope, exit 0', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        from_tasklist_id: number;
        to_tasklist_id: number;
        from_project_id: number;
        to_project_id: number;
        already_in_target_tasklist: boolean;
        task: { id: number; tasklist?: { id: number } } | null;
      };
    };
    expect(env.schema).toBe('freelo.tasks.move/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.from_tasklist_id).toBe(1100);
    expect(env.data.to_tasklist_id).toBe(1200);
    expect(env.data.from_project_id).toBe(42);
    expect(env.data.to_project_id).toBe(42);
    expect(env.data.already_in_target_tasklist).toBe(false);
    expect(env.data.task?.tasklist?.id).toBe(1200);
  });

  it('cross-project move: project changes, surfaced in envelope', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let getCount = 0;
    // First GET = pre-check (taskBefore). Second GET = post-move refresh
    // (taskAfter). Stateful counter is required because MSW resolves the
    // most-recently-registered handler first; two handlers for the same URL
    // would both serve `taskAfter`.
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '5500',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        from_project_id: number;
        to_project_id: number;
        from_tasklist_id: number;
        to_tasklist_id: number;
      };
      notice?: string;
    };
    expect(env.data.from_project_id).toBe(42);
    expect(env.data.to_project_id).toBe(99);
    expect(env.data.from_tasklist_id).toBe(1100);
    expect(env.data.to_tasklist_id).toBe(5500);
    // No --to-project supplied → no assertion notice.
    expect(env.notice).toBeUndefined();
  });

  it('idempotent skip: already in target tasklist → no POST, no refresh GET', async () => {
    const taskInTarget = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskInTarget),
      // No POST handler registered: a POST would surface as
      // `onUnhandledRequest: 'error'`, failing the test.
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        from_tasklist_id: number;
        to_tasklist_id: number;
        from_project_id: number;
        to_project_id: number;
        already_in_target_tasklist: boolean;
      };
    };
    expect(env.data.from_tasklist_id).toBe(1200);
    expect(env.data.to_tasklist_id).toBe(1200);
    expect(env.data.from_project_id).toBe(42);
    expect(env.data.to_project_id).toBe(42);
    expect(env.data.already_in_target_tasklist).toBe(true);
  });

  it('human mode renders the success line', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Moved task #9012');
    expect(stdout).toContain('tasklist #1100');
    expect(stdout).toContain('tasklist #1200');
  });

  it('human mode renders cross-project line with project change', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '5500',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('project #42');
    expect(stdout).toContain('#99');
  });

  it('human mode renders idempotent skip line', async () => {
    const taskInTarget = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    server.use(tasksShowHandlers.detailOk(9012, taskInTarget));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('was already in tasklist #1200');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks move — dry-run', () => {
  it('emits envelope with `would` block, no POST, no refresh', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(tasksShowHandlers.detailOk(9012, taskBefore));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        from_tasklist_id: number;
        to_tasklist_id: number;
        to_project_id: number | null;
        already_in_target_tasklist: boolean;
        would?: { method: string; path: string; body: unknown };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.from_tasklist_id).toBe(1100);
    expect(env.data.to_tasklist_id).toBe(1200);
    // Decision 6: dry-run does not fetch destination tasklist → null.
    expect(env.data.to_project_id).toBeNull();
    expect(env.data.already_in_target_tasklist).toBe(false);
    expect(env.data.would).toBeDefined();
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/task/9012/move/1200');
  });

  it('idempotent dry-run (already in target): NO `would` block', async () => {
    const taskInTarget = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    server.use(tasksShowHandlers.detailOk(9012, taskInTarget));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        already_in_target_tasklist: boolean;
        would?: unknown;
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.already_in_target_tasklist).toBe(true);
    // No POST would have run → no `would` (decision 6).
    expect(env.data.would).toBeUndefined();
  });

  it('dry-run with --to-project: assertion is recorded but not verified', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(tasksShowHandlers.detailOk(9012, taskBefore));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--to-project',
      '99',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { to_project_id: number | null };
      notice?: string;
    };
    // Dry-run: we don't fetch the destination tasklist → to_project_id stays null.
    expect(env.data.to_project_id).toBeNull();
    // No verification possible in dry-run → no notice.
    expect(env.notice).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  --to-project assertion
// ---------------------------------------------------------------------------

describe('freelo tasks move — --to-project assertion', () => {
  it('match: no notice, exit 0', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '5500',
      '--to-project',
      '99',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { to_project_id: number };
      notice?: string;
    };
    expect(env.data.to_project_id).toBe(99);
    expect(env.notice).toBeUndefined();
  });

  it('mismatch: notice present, exit 0', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '5500',
      '--to-project',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { to_project_id: number };
      notice?: string;
    };
    expect(env.data.to_project_id).toBe(99);
    expect(env.notice).toBeDefined();
    expect(env.notice).toContain('--to-project asserted 42');
    expect(env.notice).toContain('project 99');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks move — validation', () => {
  it('non-numeric <id> → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      'abc',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('zero <id> → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '0',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing --to-tasklist → exit 2 (Commander required-option error)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'move', '9012']);

    // Commander's required-option violation surfaces as an exit-1 in the
    // default handler, but we route through `handleTopLevelError`. Either
    // way the call must NOT reach the API; assert exitCode is non-zero AND
    // the user-facing message mentions --to-tasklist.
    expect(exitCode).not.toBe(0);
    expect(stderr.toLowerCase()).toContain('to-tasklist');
  });

  it('non-numeric --to-tasklist → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      'abc',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('zero --to-tasklist → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('non-numeric --to-project → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--to-project',
      'abc',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo tasks move — HTTP errors', () => {
  it('pre-check 404 → NOT_FOUND exit 4', async () => {
    server.use(tasksShowHandlers.detailNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('pre-check 401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksShowHandlers.detailUnauthorized(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('POST 403 → FORBIDDEN exit 4', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskBefore),
      tasksMoveHandlers.moveForbidden(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
  });

  it('POST 5xx → SERVER_ERROR exit 4', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskBefore),
      tasksMoveHandlers.moveServerError(9012, 1200, 503),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });

  it('POST 429 → RATE_LIMITED exit 6', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskBefore),
      tasksMoveHandlers.moveRateLimited(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('POST network failure → NETWORK_ERROR exit 5', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskBefore),
      tasksMoveHandlers.moveNetworkError(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Edge cases
// ---------------------------------------------------------------------------

describe('freelo tasks move — edge cases', () => {
  it('deleted-task pre-check → VALIDATION_ERROR exit 2 with hint', async () => {
    const taskDeleted = await loadFixture<Record<string, unknown>>('move-9012-deleted.json');
    server.use(tasksShowHandlers.detailOk(9012, taskDeleted));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      error: { code: string; message: string; hint_next: string | null };
    };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('deleted');
    expect(env.error.hint_next).toContain('Restore');
  });

  it('refresh GET fails post-move → success-with-notice, task: null', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    let getCount = 0;
    // First GET = pre-check (200). Second GET = post-move refresh (500).
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        if (getCount === 1) return HttpResponse.json(taskBefore);
        return HttpResponse.json({ errors: ['boom'] }, { status: 500 });
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task: unknown; to_project_id: number | null; to_tasklist_id: number };
      notice?: string;
    };
    expect(env.data.task).toBeNull();
    expect(env.data.to_project_id).toBeNull();
    expect(env.data.to_tasklist_id).toBe(1200);
    expect(env.notice).toBeDefined();
    expect(env.notice).toContain('Move applied');
    expect(env.notice).toContain('refresh GET failed');
  });

  it('pre-check task with no tasklist ref → from_tasklist_id null, move proceeds', async () => {
    const taskNoTasklist = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1100.json',
    );
    // Strip the tasklist field to simulate Freelo's null behavior.
    const noTasklist: Record<string, unknown> = { ...taskNoTasklist, tasklist: null };
    const taskAfter = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    let getCount = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        return HttpResponse.json(getCount === 1 ? noTasklist : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '9012',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        from_tasklist_id: number | null;
        to_tasklist_id: number;
        already_in_target_tasklist: boolean;
      };
    };
    expect(env.data.from_tasklist_id).toBeNull();
    expect(env.data.to_tasklist_id).toBe(1200);
    expect(env.data.already_in_target_tasklist).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo tasks move — introspect', () => {
  it('shows in --introspect with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const move = env.data.commands.find((c) => c.name === 'tasks move');
    expect(move).toBeDefined();
    expect(move?.output_schema).toBe('freelo.tasks.move/v1');
    expect(move?.destructive).toBe(false);
  });
});
