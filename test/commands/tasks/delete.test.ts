/**
 * End-to-end tests for `freelo tasks delete` (R13, spec 0024).
 *
 * The first destructive command. Covers:
 *   - Happy paths (single, multi positional, --ids, --stdin) gated behind --yes.
 *   - --dry-run (skips confirmation AND wire call).
 *   - Idempotent 404-after-DELETE → success-with-already_in_target_state.
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad ids, mutex inputs, missing source, NDJSON schema.
 *   - HTTP errors: 401/403/404 (handled), 5xx, 429, network.
 *   - Batch continue-on-error and exit-code max-of semantics.
 *   - Single-mode envelope has no `line_index` (R11/R12 byte-compat).
 *   - Introspect entry shows `destructive: true`.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts
 * that exit code. Calibration §2: each typed error class has a triggering
 * test (`ValidationError`, `ConfirmationError`, `FreeloApiError` 401/403/404,
 * `RateLimitedError`, `NetworkError`). Calibration §4: the new try/catch
 * arms (404 re-classification, batch per-id catch) have dedicated rows.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksDeleteHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  // Default: non-TTY (agent path). Tests that need TTY mock it explicitly.
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

describe('freelo tasks delete — happy paths', () => {
  it('single id with --yes: JSON envelope, current_state=deleted, exit 0', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        previous_state: string | null;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.tasks.delete/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.previous_state).toBeNull();
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('single id with --yes: human mode renders Deleted line', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Deleted task #9012');
  });

  it('multi positional with --yes: NDJSON output, two success envelopes', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012), tasksDeleteHandlers.deleteOk(9013));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '9013',
      '--yes',
      '--output',
      'ndjson',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line['schema']).toBe('freelo.tasks.delete/v1');
      const data = line['data'] as Record<string, unknown>;
      expect(data['current_state']).toBe('deleted');
      // Multi positional: no line_index (R11/R12 byte-compat).
      expect('line_index' in data).toBe(false);
    }
  });

  it('--ids "9012,9013" with --yes: equivalent NDJSON output', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012), tasksDeleteHandlers.deleteOk(9013));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '--ids',
      '9012,9013',
      '--yes',
      '--output',
      'ndjson',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0]!['data'] as { task_id: number }).task_id).toBe(9012);
    expect((lines[1]!['data'] as { task_id: number }).task_id).toBe(9013);
  });

  it('--stdin with --yes: NDJSON input/output, line_index per row', async () => {
    server.use(
      tasksDeleteHandlers.deleteOk(9012),
      tasksDeleteHandlers.deleteOk(9013),
      tasksDeleteHandlers.deleteOk(9014),
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
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      for (let i = 0; i < 3; i += 1) {
        expect(lines[i]!['schema']).toBe('freelo.tasks.delete/v1');
        const data = lines[i]!['data'] as { line_index: number; task_id: number };
        expect(data.line_index).toBe(i);
      }
      expect((lines[0]!['data'] as { task_id: number }).task_id).toBe(9012);
      expect((lines[2]!['data'] as { task_id: number }).task_id).toBe(9014);
    } finally {
      restore();
    }
  });

  it('--stdin empty: silent success exit 0 (no confirmation prompt fires)', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      // No --yes; non-TTY. If empty-stdin short-circuited correctly, no
      // confirmation gate fires and exit is 0. If the gate incorrectly
      // fires before short-circuit, we'd get exit 2.
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
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
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks delete — dry-run', () => {
  it('single id --dry-run (no --yes, non-TTY): no DELETE hit, would block, exit 0', async () => {
    // No DELETE handler registered. If a DELETE were issued, MSW's
    // onUnhandledRequest: 'error' would fail the test.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        task_id: number;
        previous_state: string | null;
        current_state: string;
        already_in_target_state: boolean;
        would?: { method: string; path: string; body: unknown };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
    expect(env.data.previous_state).toBeNull();
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.would).toBeDefined();
    expect(env.data.would?.method).toBe('DELETE');
    expect(env.data.would?.path).toBe('/task/9012');
    expect(env.data.would?.body).toEqual({});
  });

  it('--stdin --dry-run (no --yes, non-TTY): per-row dry envelopes, no DELETE hits', async () => {
    const ndjson = `${JSON.stringify({ id: 9012 })}\n${JSON.stringify({ id: 9013 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
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
        const data = line['data'] as { would: { method: string; path: string } };
        expect(data.would.method).toBe('DELETE');
      }
      expect((lines[0]!['data'] as { would: { path: string } }).would.path).toBe('/task/9012');
      expect((lines[1]!['data'] as { would: { path: string } }).would.path).toBe('/task/9013');
    } finally {
      restore();
    }
  });

  it('human mode dry-run line', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would delete task #9012');
  });
});

// ---------------------------------------------------------------------------
//  Idempotency (404 after DELETE)
// ---------------------------------------------------------------------------

describe('freelo tasks delete — idempotency (404 → already_in_target_state)', () => {
  it('single id, DELETE 404 → success envelope with already_in_target_state: true', async () => {
    server.use(tasksDeleteHandlers.deleteNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.tasks.delete/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('human mode idempotent line', async () => {
    server.use(tasksDeleteHandlers.deleteNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #9012 was already deleted');
  });

  it('batch with one row 404: success envelope on that row, exit 0 overall', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012), tasksDeleteHandlers.deleteNotFound(9013));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '9013',
      '--yes',
      '--output',
      'ndjson',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(
      (lines[0]!['data'] as { already_in_target_state: boolean }).already_in_target_state,
    ).toBe(false);
    expect(
      (lines[1]!['data'] as { already_in_target_state: boolean }).already_in_target_state,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo tasks delete — confirmation', () => {
  it('non-TTY without --yes: CONFIRMATION_REQUIRED exit 2, no DELETE hit', async () => {
    // No DELETE handler. If the command attempted a wire call, the
    // unhandled-request error would supersede our assertion.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'delete', '9012', '--output', 'json']);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      error: { code: string; message: string; hint_next: string | null };
    };
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(env.error.hint_next).toContain('--yes');
  });

  it('non-TTY without --yes + --ids batch: confirmation throws once, no per-id loop', async () => {
    // No DELETE handlers — if any were attempted, MSW would error.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '--ids',
      '9012,9013,9014',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    // Plural messaging for multi-id confirm.
    expect(env.error.message).toContain('Delete 3 tasks?');
  });

  it('non-TTY without --yes + --dry-run: no confirmation needed, dry envelope emitted', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { dry_run?: boolean; data: { task_id: number } };
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks delete — validation', () => {
  it('non-numeric <id> → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      'abc',
      '--yes',
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
      'delete',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--ids "" (empty after split) → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '--ids',
      '',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    // Empty --ids triggers "no source supplied" check (sourceCount === 0)
    // before the parser runs — both are VALIDATION_ERROR exit 2.
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('mutex: positional <id> + --stdin → VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '9012',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.message.toLowerCase()).toContain('exactly one');
    } finally {
      restore();
    }
  });

  it('mutex: positional <id> + --ids → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--ids',
      '9013',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('mutex: --ids + --stdin → VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--ids',
        '9012',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });

  it('no source at all → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('NDJSON line missing `id` → per-line VALIDATION_ERROR, exit 2', async () => {
    const ndjson = `${JSON.stringify({ foo: 'bar' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
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

  it('NDJSON line with extra key → per-line VALIDATION_ERROR (zod .strict)', async () => {
    const ndjson = `${JSON.stringify({ id: 9012, extra: 'nope' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
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

  it('NDJSON line with non-positive `id` → per-line VALIDATION_ERROR', async () => {
    const ndjson = `${JSON.stringify({ id: 0 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
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
//  HTTP errors (calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo tasks delete — HTTP errors', () => {
  it('DELETE 401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksDeleteHandlers.deleteUnauthorized(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('DELETE 403 → FORBIDDEN exit 4', async () => {
    server.use(tasksDeleteHandlers.deleteForbidden(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
  });

  it('DELETE 5xx → SERVER_ERROR exit 4', async () => {
    server.use(tasksDeleteHandlers.deleteServerError(9012, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number | null } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });

  it('DELETE 429 (writes do NOT retry) → RATE_LIMITED exit 6', async () => {
    server.use(tasksDeleteHandlers.deleteRateLimited(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('DELETE network failure → NETWORK_ERROR exit 5', async () => {
    server.use(tasksDeleteHandlers.deleteNetworkError(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Batch continue-on-error
// ---------------------------------------------------------------------------

describe('freelo tasks delete --stdin — continue-on-error', () => {
  it('valid + bad-JSON + valid: 2 success + 1 error envelope, exit 2, in input order', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012), tasksDeleteHandlers.deleteOk(9013));

    const ndjson =
      `${JSON.stringify({ id: 9012 })}\n` + `{"id": broken\n` + `${JSON.stringify({ id: 9013 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect(lines[0]!['schema']).toBe('freelo.tasks.delete/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect((lines[1]!['error'] as { context: { line_index: number } }).context.line_index).toBe(
        1,
      );
      expect(lines[2]!['schema']).toBe('freelo.tasks.delete/v1');
    } finally {
      restore();
    }
  });

  it('valid + 401 mid-batch: per-line errors, exit 3 (auth dominates)', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012), tasksDeleteHandlers.deleteUnauthorized(9013));

    const ndjson = `${JSON.stringify({ id: 9012 })}\n${JSON.stringify({ id: 9013 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(3);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.tasks.delete/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      const err = lines[1]!['error'] as { code: string; http_status: number | null };
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.http_status).toBe(401);
    } finally {
      restore();
    }
  });

  it('mixed exit codes: max wins (validation 2 + 5xx 4 → exit 4)', async () => {
    server.use(tasksDeleteHandlers.deleteServerError(9013, 500));

    const ndjson =
      `${JSON.stringify({ id: 0 })}\n` + // VALIDATION_ERROR (per-line, zod) → 2
      `${JSON.stringify({ id: 9013 })}\n`; // SERVER_ERROR → 4
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('multi positional with one mid-batch SERVER_ERROR: per-id error envelope, exit 4', async () => {
    server.use(
      tasksDeleteHandlers.deleteOk(9012),
      tasksDeleteHandlers.deleteServerError(9013, 500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '9013',
      '--yes',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]!['schema']).toBe('freelo.tasks.delete/v1');
    expect(lines[1]!['schema']).toBe('freelo.error/v1');
    // Positional / --ids: input_index, not line_index.
    expect(
      (lines[1]!['error'] as { context: { input_index?: number; task_id?: number } }).context
        .input_index,
    ).toBe(1);
    expect((lines[1]!['error'] as { context: { task_id?: number } }).context.task_id).toBe(9013);
  });
});

// ---------------------------------------------------------------------------
//  Single-mode regression — line_index absent in single-mode envelope
// ---------------------------------------------------------------------------

describe('freelo tasks delete single-mode — line_index absent', () => {
  it('single-mode success envelope has no `line_index` field', async () => {
    server.use(tasksDeleteHandlers.deleteOk(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('line_index' in env.data).toBe(false);
  });

  it('single-mode dry-run envelope has no `line_index` field', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('line_index' in env.data).toBe(false);
  });

  it('single-mode idempotent (404) envelope has no `line_index` field', async () => {
    server.use(tasksDeleteHandlers.deleteNotFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'delete',
      '9012',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('line_index' in env.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo tasks delete — introspect', () => {
  it('shows in --introspect with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const del = env.data.commands.find((c) => c.name === 'tasks delete');
    expect(del).toBeDefined();
    expect(del?.output_schema).toBe('freelo.tasks.delete/v1');
    expect(del?.destructive).toBe(true);
  });
});
