/**
 * End-to-end tests for `freelo tasks estimate set` (R37, spec 0051).
 *
 * Covers:
 *   - Happy path live (total): envelope shape, wire body shape.
 *   - Happy path live (per-user): envelope `scope: 'user'`, wire path includes user id.
 *   - Dry-run (total + per-user): no wire call, `dry_run: true`, `would.body.minutes` echo.
 *   - Validation: missing --minutes, --minutes 0, --minutes -5, --minutes 1.5,
 *     --minutes abc, --user 0, --user abc, bad <id>.
 *   - HTTP errors: 401, 403, 404, 5xx.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class triggers explicitly
 * (`ValidationError` exit 2, `FreeloApiError` exit 3 for 401, exit 4 for 403/404/5xx).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksEstimateSetHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-estimate-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  // Default: non-TTY (agent path).
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
//  Happy path
// ---------------------------------------------------------------------------

describe('freelo tasks estimate set — happy paths', () => {
  // Note: ordering — the simple `okTotal` happy-path runs first so the ESM
  // cold-start work (which inflates the first test by 5–10 s on Windows
  // matrix) is absorbed by a test that does not need to assert wire-body
  // shape. Tests that capture the wire body (`okTotalWhenBody`) come later
  // after the module graph is warm. Mirrors the R35 ordering.
  it('total: --minutes 120 → envelope scope=total, user_id=null', async () => {
    server.use(tasksEstimateSetHandlers.okTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        user_id: number | null;
        minutes: number;
        scope: string;
      };
    };
    expect(env.schema).toBe('freelo.tasks.estimate.set/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.user_id).toBeNull();
    expect(env.data.minutes).toBe(120);
    expect(env.data.scope).toBe('total');
  });

  it('total: wire body is { minutes: <n> }', async () => {
    let captured: unknown;
    server.use(
      tasksEstimateSetHandlers.okTotalWhenBody(4567, (body) => {
        captured = body;
        const b = body as { minutes?: number };
        return b.minutes === 120;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 120 });
  });

  it('per-user: --minutes 90 --user 42 → envelope scope=user, user_id=42', async () => {
    server.use(tasksEstimateSetHandlers.okUser(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task_id: number; user_id: number | null; minutes: number; scope: string };
    };
    expect(env.data.task_id).toBe(4567);
    expect(env.data.user_id).toBe(42);
    expect(env.data.minutes).toBe(90);
    expect(env.data.scope).toBe('user');
  });

  it('per-user: wire path includes user id and body is { minutes: <n> }', async () => {
    let captured: unknown;
    server.use(
      tasksEstimateSetHandlers.okUserWhenBody(4567, 42, (body) => {
        captured = body;
        const b = body as { minutes?: number };
        return b.minutes === 90;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 90 });
  });

  it('total: human mode renders one terse line', async () => {
    server.use(tasksEstimateSetHandlers.okTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Total time estimate');
    expect(stdout).toContain('task #4567');
    expect(stdout).toContain('120 min');
  });

  it('per-user: human mode renders "for user #42" line', async () => {
    server.use(tasksEstimateSetHandlers.okUser(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      '42',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Time estimate for user #42');
    expect(stdout).toContain('task #4567');
    expect(stdout).toContain('90 min');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks estimate set — dry-run', () => {
  it('--dry-run total: no wire call, dry_run=true, would echoes total path + body', async () => {
    // No handler — onUnhandledRequest: 'error' would fail any wire call.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        task_id: number;
        user_id: number | null;
        minutes: number;
        scope: string;
        would: { method: string; path: string; body: { minutes: number } };
      };
    };
    expect(env.schema).toBe('freelo.tasks.estimate.set/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.user_id).toBeNull();
    expect(env.data.scope).toBe('total');
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/4567/total-time-estimate');
    expect(env.data.would.body.minutes).toBe(120);
  });

  it('--dry-run per-user: would.path includes user id', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      '42',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        user_id: number | null;
        scope: string;
        would: { path: string; body: { minutes: number } };
      };
    };
    expect(env.data.user_id).toBe(42);
    expect(env.data.scope).toBe('user');
    expect(env.data.would.path).toBe('/task/4567/users-time-estimates/42');
    expect(env.data.would.body.minutes).toBe(90);
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks estimate set — validation', () => {
  it('missing --minutes → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('--minutes is required');
  });

  it('--minutes 0 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--minutes -5 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '-5',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--minutes 1.5 (non-integer) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '1.5',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--minutes abc → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--user 0 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--user abc → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '90',
      '--user',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      'abc',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('zero <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '0',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths
// ---------------------------------------------------------------------------

describe('freelo tasks estimate set — HTTP errors', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksEstimateSetHandlers.unauthorizedTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → FORBIDDEN exit 4', async () => {
    server.use(tasksEstimateSetHandlers.forbiddenTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → NOT_FOUND exit 4', async () => {
    server.use(tasksEstimateSetHandlers.notFoundTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('500 → FREELO_API_ERROR exit 4', async () => {
    server.use(tasksEstimateSetHandlers.serverErrorTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'set',
      '4567',
      '--minutes',
      '120',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
