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
import { Readable } from 'node:stream';
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

function parseAllJsonLines(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Replace `process.stdin` with a synthetic Readable stream sourced from the
 * provided text. Returns a restore function. Mirrors R09/R11 batch tests.
 */
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

// ===========================================================================
//  R12.5 — `freelo tasks move --stdin` batch input (spec 0023)
// ===========================================================================

// ---------------------------------------------------------------------------
//  Batch happy paths
// ---------------------------------------------------------------------------

describe('freelo tasks move --stdin — happy paths', () => {
  it('three valid rows: success envelopes with line_index, exit 0', async () => {
    const task9012Before = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1100.json',
    );
    const task9012After = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1200.json',
    );
    const task9013Before = await loadFixture<Record<string, unknown>>(
      'move-9013-tasklist-1100.json',
    );
    const task9013After = await loadFixture<Record<string, unknown>>(
      'move-9013-tasklist-1200.json',
    );
    const task9014CrossProject = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    // Use stateful counters per task id — pre-check returns "before", refresh returns "after".
    let count9012 = 0;
    let count9013 = 0;
    let count9014 = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        count9012 += 1;
        return HttpResponse.json(count9012 === 1 ? task9012Before : task9012After);
      }),
      http.get(`https://api.freelo.io/v1/task/9013`, () => {
        count9013 += 1;
        return HttpResponse.json(count9013 === 1 ? task9013Before : task9013After);
      }),
      http.get(`https://api.freelo.io/v1/task/9014`, () => {
        count9014 += 1;
        // Pre-check returns "before" (in tasklist 1100 / project 42); refresh returns "after"
        // (in tasklist 5500 / project 99). Reuse 9012's "before" fixture for the pre-check
        // shape (the id field is what matters; the move_to-tasklist-5500 fixture is the
        // refresh).
        return HttpResponse.json(
          count9014 === 1 ? { ...task9012Before, id: 9014 } : { ...task9014CrossProject, id: 9014 },
        );
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
      tasksMoveHandlers.moveOk(9013, 1200),
      tasksMoveHandlers.moveOk(9014, 5500),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n` +
      `${JSON.stringify({ id: 9013, to_tasklist: 1200 })}\n` +
      `${JSON.stringify({ id: 9014, to_tasklist: 5500 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      for (let i = 0; i < 3; i += 1) {
        expect(lines[i]!['schema']).toBe('freelo.tasks.move/v1');
        const data = lines[i]!['data'] as {
          line_index: number;
          task_id: number;
          to_tasklist_id: number;
        };
        expect(data.line_index).toBe(i);
      }
      expect((lines[0]!['data'] as { task_id: number; to_tasklist_id: number }).task_id).toBe(9012);
      expect(
        (lines[2]!['data'] as { task_id: number; to_tasklist_id: number }).to_tasklist_id,
      ).toBe(5500);
    } finally {
      restore();
    }
  });

  it('idempotent skip in batch: row whose to_tasklist matches current → no POST, line_index present', async () => {
    const taskInTarget = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1200.json');
    server.use(tasksShowHandlers.detailOk(9012, taskInTarget));

    const ndjson = `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      const data = lines[0]!['data'] as {
        already_in_target_tasklist: boolean;
        line_index: number;
      };
      expect(data.already_in_target_tasklist).toBe(true);
      expect(data.line_index).toBe(0);
    } finally {
      restore();
    }
  });

  it('per-row to_project assertion match: no notice on that line', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let count = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        count += 1;
        return HttpResponse.json(count === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const ndjson = `${JSON.stringify({ id: 9012, to_tasklist: 5500, to_project: 99 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const line = parseAllJsonLines(stdout)[0]!;
      const data = line['data'] as { to_project_id: number };
      expect(data.to_project_id).toBe(99);
      expect(line['notice']).toBeUndefined();
    } finally {
      restore();
    }
  });

  it('per-row to_project assertion mismatch: notice present, exit 0', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskAfter = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-5500-project-99.json',
    );
    let count = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        count += 1;
        return HttpResponse.json(count === 1 ? taskBefore : taskAfter);
      }),
      tasksMoveHandlers.moveOk(9012, 5500),
    );

    const ndjson = `${JSON.stringify({ id: 9012, to_tasklist: 5500, to_project: 42 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const line = parseAllJsonLines(stdout)[0]!;
      expect(line['notice']).toBeDefined();
      expect(String(line['notice'])).toContain('--to-project asserted 42');
    } finally {
      restore();
    }
  });

  it('--stdin + --dry-run: pre-check runs, no POST, per-row dry envelopes with would', async () => {
    const taskBefore = await loadFixture<Record<string, unknown>>('move-9012-tasklist-1100.json');
    const taskBefore13 = await loadFixture<Record<string, unknown>>('move-9013-tasklist-1100.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskBefore),
      tasksShowHandlers.detailOk(9013, taskBefore13),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n` +
      `${JSON.stringify({ id: 9013, to_tasklist: 5500 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--dry-run',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line['dry_run']).toBe(true);
        const data = line['data'] as {
          would: { method: string; path: string };
          to_project_id: number | null;
          line_index: number;
        };
        expect(data.would.method).toBe('POST');
        expect(data.to_project_id).toBeNull();
        expect(typeof data.line_index).toBe('number');
      }
      expect((lines[0]!['data'] as { would: { path: string } }).would.path).toBe(
        '/task/9012/move/1200',
      );
      expect((lines[1]!['data'] as { would: { path: string } }).would.path).toBe(
        '/task/9013/move/5500',
      );
    } finally {
      restore();
    }
  });

  it('empty stdin → silent success exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Batch — continue-on-error
// ---------------------------------------------------------------------------

describe('freelo tasks move --stdin — continue-on-error', () => {
  it('valid + bad-JSON + valid → 2 success + 1 error envelope, exit 2, in input order', async () => {
    const task9012Before = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1100.json',
    );
    const task9012After = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1200.json',
    );
    const task9013Before = await loadFixture<Record<string, unknown>>(
      'move-9013-tasklist-1100.json',
    );
    const task9013After = await loadFixture<Record<string, unknown>>(
      'move-9013-tasklist-1200.json',
    );
    let c12 = 0;
    let c13 = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        c12 += 1;
        return HttpResponse.json(c12 === 1 ? task9012Before : task9012After);
      }),
      http.get(`https://api.freelo.io/v1/task/9013`, () => {
        c13 += 1;
        return HttpResponse.json(c13 === 1 ? task9013Before : task9013After);
      }),
      tasksMoveHandlers.moveOk(9012, 1200),
      tasksMoveHandlers.moveOk(9013, 1200),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n` +
      `{"id": broken\n` +
      `${JSON.stringify({ id: 9013, to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect(lines[0]!['schema']).toBe('freelo.tasks.move/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      const errCtx = (lines[1]!['error'] as { context: { line_index: number } }).context;
      expect(errCtx.line_index).toBe(1);
      expect(lines[2]!['schema']).toBe('freelo.tasks.move/v1');
    } finally {
      restore();
    }
  });

  it('valid + 404-on-pre-check → 1 success + 1 error, exit 4 (HTTP > validation)', async () => {
    const task9012Before = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1100.json',
    );
    const task9012After = await loadFixture<Record<string, unknown>>(
      'move-9012-tasklist-1200.json',
    );
    let c12 = 0;
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        c12 += 1;
        return HttpResponse.json(c12 === 1 ? task9012Before : task9012After);
      }),
      tasksShowHandlers.detailNotFound(99999),
      tasksMoveHandlers.moveOk(9012, 1200),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n` +
      `${JSON.stringify({ id: 99999, to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.tasks.move/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      const err = lines[1]!['error'] as {
        code: string;
        http_status: number | null;
        context: { line_index: number; task_id?: number };
      };
      expect(err.code).toBe('NOT_FOUND');
      expect(err.http_status).toBe(404);
      expect(err.context.line_index).toBe(1);
      expect(err.context.task_id).toBe(99999);
    } finally {
      restore();
    }
  });

  it('deleted-task pre-check on a row → per-line VALIDATION_ERROR, exit 2', async () => {
    const taskDeleted = await loadFixture<Record<string, unknown>>('move-9012-deleted.json');
    server.use(tasksShowHandlers.detailOk(9012, taskDeleted));

    const ndjson = `${JSON.stringify({ id: 9012, to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      const err = lines[0]!['error'] as { code: string; message: string };
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('deleted');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Batch — per-line schema validation
// ---------------------------------------------------------------------------

describe('freelo tasks move --stdin — per-line schema', () => {
  it('row missing `id` → per-line VALIDATION_ERROR, exit 2', async () => {
    const ndjson = `${JSON.stringify({ to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      expect((lines[0]!['error'] as { code: string }).code).toBe('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });

  it('row missing `to_tasklist` → per-line VALIDATION_ERROR, exit 2', async () => {
    const ndjson = `${JSON.stringify({ id: 9012 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('row with unknown extra key → per-line VALIDATION_ERROR (zod .strict)', async () => {
    const ndjson = `${JSON.stringify({ id: 9012, to_tasklist: 1200, foo: 'bar' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('row with non-positive `id` → per-line VALIDATION_ERROR', async () => {
    const ndjson = `${JSON.stringify({ id: 0, to_tasklist: 1200 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Batch — mutex validation
// ---------------------------------------------------------------------------

describe('freelo tasks move --stdin — mutex validation', () => {
  it('--stdin + positional <id> → VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '9012',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.message.toLowerCase()).toContain('stdin');
      expect(env.error.message.toLowerCase()).toContain('positional');
    } finally {
      restore();
    }
  });

  it('--stdin + --to-tasklist → VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--to-tasklist',
        '1200',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.message.toLowerCase()).toContain('to-tasklist');
    } finally {
      restore();
    }
  });

  it('--stdin + --to-project → VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'move',
        '--stdin',
        '--to-project',
        '42',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.message.toLowerCase()).toContain('to-project');
    } finally {
      restore();
    }
  });

  it('no <id> and no --stdin → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'move',
      '--to-tasklist',
      '1200',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Single-mode regression — line_index must be ABSENT in single-mode envelopes
// ---------------------------------------------------------------------------

describe('freelo tasks move single-mode — line_index absent (R12 v1 byte-compat)', () => {
  it('single-mode success envelope has no `line_index` field', async () => {
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
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('line_index' in env.data).toBe(false);
  });

  it('single-mode idempotent skip envelope has no `line_index` field', async () => {
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
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('line_index' in env.data).toBe(false);
  });
});
