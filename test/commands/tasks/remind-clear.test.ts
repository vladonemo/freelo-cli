/**
 * End-to-end tests for `freelo tasks remind clear` (R35, spec 0049).
 *
 * Covers:
 *   - Happy path live: --yes → 200 → exit 0, already_in_target_state=false.
 *   - Dry-run: no wire call, no confirmation, would.method=DELETE.
 *   - Defensive 404 → already_in_target_state=true (forward-compat).
 *   - Confirmation policy:
 *       - Non-TTY without --yes → CONFIRMATION_REQUIRED exit 2 (calibration §7).
 *       - TTY accepts → exit 0.
 *       - TTY declines → exit 2.
 *   - Validation: bad <id>.
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
import { server, tasksRemindClearHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-remind-clear-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks remind clear — happy paths', () => {
  it('--yes: 200 → envelope already_in_target_state=false, exit 0', async () => {
    server.use(tasksRemindClearHandlers.ok(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.tasks.remind.clear/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('--yes: human mode renders one terse line', async () => {
    server.use(tasksRemindClearHandlers.ok(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Reminder cleared on task #4567');
  });

  it('defensive 404 → already_in_target_state=true, exit 0', async () => {
    server.use(tasksRemindClearHandlers.notFound(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task_id: number; already_in_target_state: boolean };
    };
    expect(env.data.task_id).toBe(4567);
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('defensive 404 + human mode renders "was already cleared"', async () => {
    server.use(tasksRemindClearHandlers.notFound(4567));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
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

describe('freelo tasks remind clear — dry-run', () => {
  it('--dry-run: no wire call, no confirmation, would.method=DELETE', async () => {
    // No handler — a wire call would error. Also no --yes; non-TTY would
    // normally fail closed, but --dry-run bypasses confirmation entirely.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
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
        already_in_target_state: boolean;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.tasks.remind.clear/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe('/task/4567/reminder');
    expect(env.data.would.body).toEqual({});
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo tasks remind clear — confirmation policy', () => {
  it('non-TTY without --yes → ConfirmationError exit 2, no wire call', async () => {
    // No server handler — confirmation gate fires before any wire call.
    // If the gate failed to fire, msw would error on the unhandled request.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('TTY accepts → DELETE proceeds, exit 0 (calibration §7: clear CI)', async () => {
    // Calibration §7: GitHub Actions sets CI=true; isInteractive() returns
    // false regardless of isTTY when CI is set. Save and clear it for the
    // duration of this test so the TTY-prompt branch runs.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    server.use(tasksRemindClearHandlers.ok(4567));
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockImplementation(() => Promise.resolve(true)),
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'remind',
        'clear',
        '4567',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const env = parseFirstJson(stdout) as {
        data: { already_in_target_state: boolean };
      };
      expect(env.data.already_in_target_state).toBe(false);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY declines → ConfirmationError exit 2 (calibration §7: clear CI)', async () => {
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
        'remind',
        'clear',
        '4567',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      // Spec 0049 decision 7 — prompt copy uses "task #<id>".
      expect(captured).toContain('task #4567');
      expect(captured).toContain('Clear reminder');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks remind clear — validation', () => {
  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
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
      'remind',
      'clear',
      '0',
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

describe('freelo tasks remind clear — HTTP errors', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksRemindClearHandlers.unauthorized(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('500 → FREELO_API_ERROR exit 4', async () => {
    server.use(tasksRemindClearHandlers.serverError(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'clear',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
