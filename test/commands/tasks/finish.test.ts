/**
 * End-to-end tests for `freelo tasks finish` (R11, spec 0021).
 *
 * Covers the third write command + the new shared idempotency helper
 * (`src/lib/idempotency.ts`) used at the call site.
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class (`ValidationError`,
 * `FreeloApiError`, `NetworkError`, `RateLimitedError`) has a triggering test.
 * Calibration §4: each new try/catch arm — the per-id pre-check catch and
 * the per-id POST catch in batch — has a dedicated test row.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksTransitionHandlers, tasksShowHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-finish-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks finish — happy paths', () => {
  it('single id (active → finished): JSON envelope, exit 0', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishOk(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        previous_state: string;
        current_state: string;
        already_in_target_state: boolean;
        verb: string;
      };
    };
    expect(env.schema).toBe('freelo.tasks.finish/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.previous_state).toBe('active');
    expect(env.data.current_state).toBe('finished');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.verb).toBe('finish');
  });

  it('idempotent skip: already finished → no POST, already_in_target_state: true', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(
      tasksShowHandlers.detailOk(9012, taskFinished),
      // No POST handler registered: a POST would surface as
      // `onUnhandledRequest: 'error'`, failing the test.
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { previous_state: string; current_state: string; already_in_target_state: boolean };
    };
    expect(env.data.previous_state).toBe('finished');
    expect(env.data.current_state).toBe('finished');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('multiple positional ids → 3 envelopes, exit 0', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9013, { ...taskActive, id: 9013 }),
      tasksShowHandlers.detailOk(9014, { ...taskActive, id: 9014 }),
      tasksTransitionHandlers.finishOk(9012),
      tasksTransitionHandlers.finishOk(9013),
      tasksTransitionHandlers.finishOk(9014),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '9013',
      '9014',
      '--output',
      'ndjson',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
    expect((lines[0]!['data'] as { task_id: number }).task_id).toBe(9012);
    expect((lines[1]!['data'] as { task_id: number }).task_id).toBe(9013);
    expect((lines[2]!['data'] as { task_id: number }).task_id).toBe(9014);
    for (const line of lines) {
      expect(line['schema']).toBe('freelo.tasks.finish/v1');
    }
  });

  it('--ids comma-separated → resolves to multiple ids, 2 envelopes', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9013, { ...taskActive, id: 9013 }),
      tasksTransitionHandlers.finishOk(9012),
      tasksTransitionHandlers.finishOk(9013),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '--ids',
      '9012,9013',
      '--output',
      'ndjson',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('human mode renders the success line', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishOk(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Finished task #9012');
    expect(stdout).toContain('was active');
  });

  it('human mode renders idempotent skip line', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(tasksShowHandlers.detailOk(9012, taskFinished));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #9012 was already finished');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks finish — dry-run', () => {
  it('--dry-run on active task: pre-check runs, NO POST, envelope has dry_run + would', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(tasksShowHandlers.detailOk(9012, taskActive));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        task_id: number;
        previous_state: string;
        current_state: string;
        already_in_target_state: boolean;
        would: { method: string; path: string; body: unknown };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
    expect(env.data.previous_state).toBe('active');
    // No POST happened; current_state echoes previous_state in dry-run.
    expect(env.data.current_state).toBe('active');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/9012/finish');
    expect(env.data.would.body).toEqual({});
  });

  it('--dry-run on already-finished: NO would (decision 9), already_in_target_state: true', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(tasksShowHandlers.detailOk(9012, taskFinished));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; would?: unknown };
    };
    // Already-in-target short-circuits before the dry-run branch, so there's
    // no `would` and no top-level `dry_run: true` (the envelope is the
    // standard "skipped" success envelope).
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.would).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
//  Validation failures (ValidationError, exit 2)
// ---------------------------------------------------------------------------

describe('freelo tasks finish — validation', () => {
  it('non-numeric positional id → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      'not-a-number',
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

  it('zero positional id → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'finish', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('--ids combined with positional <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'finish',
      '9012',
      '--ids',
      '9013',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/exactly one input source/);
  });

  it('--stdin combined with positional <id> → exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'tasks',
        'finish',
        '9012',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
    } finally {
      restore();
    }
  });

  it('--ids 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'finish', '--ids', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('zero ids resolved (no positional, no --ids) → silent success exit 0', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'finish', '--output', 'json']);
    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('pre-check shows deleted task → VALIDATION_ERROR exit 2 (decision 14)', async () => {
    const taskDeleted = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    const deletedFixture = { ...taskDeleted, state: { id: 4, state: 'deleted' } };
    server.use(tasksShowHandlers.detailOk(9012, deletedFixture));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/deleted/);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths (FreeloApiError, RateLimitedError, NetworkError)
// ---------------------------------------------------------------------------

describe('freelo tasks finish — HTTP errors', () => {
  it('pre-check 404 → NOT_FOUND exit 4, no POST attempted', async () => {
    server.use(tasksShowHandlers.detailNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('pre-check 401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksShowHandlers.detailUnauthorized(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('POST 403 → FORBIDDEN exit 4', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishForbidden(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
  });

  it('POST 429 → RATE_LIMITED exit 6, retryable: true', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishRateLimited(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string; retryable: boolean } };
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('POST network failure → NETWORK_ERROR exit 5', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishNetworkError(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });

  it('POST 5xx → SERVER_ERROR exit 4, retryable: true', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskActive),
      tasksTransitionHandlers.finishServerError(9012, 503),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'finish', '9012', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
//  Batch (--stdin) mode
// ---------------------------------------------------------------------------

describe('freelo tasks finish — batch (--stdin)', () => {
  it('three valid lines → three success envelopes, line_index, exit 0', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9013, { ...taskActive, id: 9013 }),
      tasksShowHandlers.detailOk(9014, { ...taskActive, id: 9014 }),
      tasksTransitionHandlers.finishOk(9012),
      tasksTransitionHandlers.finishOk(9013),
      tasksTransitionHandlers.finishOk(9014),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012 })}\n` +
      `${JSON.stringify({ id: 9013 })}\n` +
      `${JSON.stringify({ id: 9014 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      for (let i = 0; i < 3; i += 1) {
        const data = lines[i]!['data'] as { line_index: number; task_id: number };
        expect(data.line_index).toBe(i);
        expect(data.task_id).toBe(9012 + i);
      }
    } finally {
      restore();
    }
  });

  it('valid + bad-JSON + valid → 2 success + 1 error, exit 2', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9014, { ...taskActive, id: 9014 }),
      tasksTransitionHandlers.finishOk(9012),
      tasksTransitionHandlers.finishOk(9014),
    );

    const ndjson =
      `${JSON.stringify({ id: 9012 })}\n` + `{"id": broken\n` + `${JSON.stringify({ id: 9014 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect(lines[0]!['schema']).toBe('freelo.tasks.finish/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect((lines[1]!['error'] as { context: { line_index: number } }).context.line_index).toBe(
        1,
      );
      expect(lines[2]!['schema']).toBe('freelo.tasks.finish/v1');
    } finally {
      restore();
    }
  });

  it('valid + 422-from-API → 1 success + 1 error, exit 4 (HTTP > validation)', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9013, { ...taskActive, id: 9013 }),
      tasksTransitionHandlers.finishOk(9012),
      tasksTransitionHandlers.finishServerError(9013, 422),
    );

    const ndjson = `${JSON.stringify({ id: 9012 })}\n` + `${JSON.stringify({ id: 9013 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.tasks.finish/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect((lines[1]!['error'] as { http_status: number }).http_status).toBe(422);
    } finally {
      restore();
    }
  });

  it('NDJSON line with string `id` → per-line VALIDATION_ERROR, batch continues, exit 2', async () => {
    const ndjson = `${JSON.stringify({ id: '9012' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
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

  it('NDJSON line with extra unknown key → per-line VALIDATION_ERROR (strict)', async () => {
    const ndjson = `${JSON.stringify({ id: 9012, foo: 'bar' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
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

  it('empty stdin → silent success, exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
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

  it('--stdin + --dry-run: pre-check runs per id, no POSTs, per-line dry envelopes', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    server.use(
      tasksShowHandlers.detailOk(9012, { ...taskActive, id: 9012 }),
      tasksShowHandlers.detailOk(9013, { ...taskActive, id: 9013 }),
    );

    const ndjson = `${JSON.stringify({ id: 9012 })}\n${JSON.stringify({ id: 9013 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'finish',
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
        const data = line['data'] as { would: { method: string }; line_index: number };
        expect(data.would.method).toBe('POST');
        expect(typeof data.line_index).toBe('number');
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo tasks finish — introspect', () => {
  it('shows up in --introspect with the right schema and destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          output_schema: string;
          destructive: boolean;
        }>;
      };
    };
    const finish = env.data.commands.find((c) => c.name === 'tasks finish');
    expect(finish).toBeDefined();
    expect(finish!.output_schema).toBe('freelo.tasks.finish/v1');
    expect(finish!.destructive).toBe(false);
  });
});
