/**
 * End-to-end tests for `freelo tasks estimate clear` (R37, spec 0051).
 *
 * Covers:
 *   - Happy path live (total + per-user): --yes → 200 → exit 0,
 *     already_in_target_state=false, scope discriminator correct.
 *   - Dry-run (total + per-user): no wire call, would.method=DELETE,
 *     would.path correct.
 *   - Defensive 404 (total + per-user) → already_in_target_state=true.
 *   - Confirmation policy:
 *       - Non-TTY without --yes → CONFIRMATION_REQUIRED exit 2 (calibration §7).
 *       - TTY accepts (total) → exit 0; prompt copy contains "total time estimate".
 *       - TTY declines (per-user) → exit 2; prompt copy contains "user #42".
 *   - Validation: bad <id>, --user 0, --user abc.
 *   - HTTP errors: 401, 5xx.
 *
 * Calibration §1: each error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class triggers explicitly
 * (`ValidationError`, `ConfirmationError`, `FreeloApiError`). Calibration §4:
 * the new try/catch arm (404 re-classification) has dedicated coverage.
 * Calibration §7: TTY-prompt tests clear `process.env.CI`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksEstimateClearHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-estimate-clear-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks estimate clear — happy paths', () => {
  it('total --yes: 200 → envelope scope=total, user_id=null, already_in_target_state=false', async () => {
    server.use(tasksEstimateClearHandlers.okTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        user_id: number | null;
        scope: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.tasks.estimate.clear/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.user_id).toBeNull();
    expect(env.data.scope).toBe('total');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('per-user --yes: 200 → envelope scope=user, user_id=42', async () => {
    server.use(tasksEstimateClearHandlers.okUser(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--user',
      '42',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        task_id: number;
        user_id: number | null;
        scope: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.data.user_id).toBe(42);
    expect(env.data.scope).toBe('user');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('total --yes: human mode renders one terse line', async () => {
    server.use(tasksEstimateClearHandlers.okTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Total time estimate cleared on task #4567');
  });

  it('per-user --yes: human mode renders "for user #42" line', async () => {
    server.use(tasksEstimateClearHandlers.okUser(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--user',
      '42',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Time estimate for user #42 cleared on task #4567');
  });

  it('defensive 404 (total) → already_in_target_state=true, exit 0', async () => {
    server.use(tasksEstimateClearHandlers.notFoundTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; scope: string };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.scope).toBe('total');
  });

  it('defensive 404 (per-user) → already_in_target_state=true, scope=user', async () => {
    server.use(tasksEstimateClearHandlers.notFoundUser(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--user',
      '42',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { user_id: number | null; scope: string; already_in_target_state: boolean };
    };
    expect(env.data.user_id).toBe(42);
    expect(env.data.scope).toBe('user');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('defensive 404 (total) + human mode renders "was already cleared"', async () => {
    server.use(tasksEstimateClearHandlers.notFoundTotal(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('was already cleared');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks estimate clear — dry-run', () => {
  it('total --dry-run: no wire call, no confirmation, would.path=total', async () => {
    // No handler — wire would error. No --yes; non-TTY would normally fail
    // closed, but --dry-run bypasses confirmation entirely.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
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
        scope: string;
        already_in_target_state: boolean;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.tasks.estimate.clear/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.user_id).toBeNull();
    expect(env.data.scope).toBe('total');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe('/task/4567/total-time-estimate');
    expect(env.data.would.body).toEqual({});
  });

  it('per-user --dry-run: would.path includes user id', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
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
        would: { path: string };
      };
    };
    expect(env.data.user_id).toBe(42);
    expect(env.data.scope).toBe('user');
    expect(env.data.would.path).toBe('/task/4567/users-time-estimates/42');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo tasks estimate clear — confirmation policy', () => {
  it('non-TTY without --yes → ConfirmationError exit 2, no wire call', async () => {
    // No server handler — confirmation gate fires before any wire call.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('TTY accepts (total) → DELETE proceeds, exit 0; prompt mentions "total time estimate" (calibration §7: clear CI)', async () => {
    // Calibration §7: GitHub Actions sets CI=true; isInteractive() returns
    // false regardless of isTTY when CI is set.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    server.use(tasksEstimateClearHandlers.okTotal(4567));
    let captured = '';
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockImplementation((opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(true);
      }),
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'estimate',
        'clear',
        '4567',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const env = parseFirstJson(stdout) as {
        data: { already_in_target_state: boolean; scope: string };
      };
      expect(env.data.already_in_target_state).toBe(false);
      expect(env.data.scope).toBe('total');
      // Spec 0051 decision 7 — total-scope prompt copy.
      expect(captured).toContain('total time estimate');
      expect(captured).toContain('task #4567');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY declines (per-user) → ConfirmationError exit 2; prompt mentions "user #42" (calibration §7: clear CI)', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    let captured = '';
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockImplementation((opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(false);
      }),
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'tasks',
        'estimate',
        'clear',
        '4567',
        '--user',
        '42',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      // Spec 0051 decision 7 — per-user-scope prompt copy.
      expect(captured).toContain('user #42');
      expect(captured).toContain('task #4567');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks estimate clear — validation', () => {
  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      'abc',
      '--yes',
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
      'clear',
      '0',
      '--yes',
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
      'clear',
      '4567',
      '--user',
      '0',
      '--yes',
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
      'clear',
      '4567',
      '--user',
      'abc',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths
// ---------------------------------------------------------------------------

describe('freelo tasks estimate clear — HTTP errors', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksEstimateClearHandlers.unauthorizedTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('500 → FREELO_API_ERROR exit 4', async () => {
    server.use(tasksEstimateClearHandlers.serverErrorTotal(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'estimate',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
