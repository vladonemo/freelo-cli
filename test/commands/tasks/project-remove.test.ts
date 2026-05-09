/**
 * End-to-end tests for `freelo tasks project remove` (R38, spec 0052).
 *
 * Covers:
 *   - Happy path live + --yes: envelope shape, already_in_target_state: false.
 *   - Defensive 404 → idempotent (already_in_target_state: true).
 *   - 403 (primary project) → exit 4 with hintNext mentioning `tasks delete`.
 *   - Dry-run: no wire call, no prompt, would.path echoes.
 *   - Non-TTY without --yes → exit 2 (CONFIRMATION_REQUIRED).
 *   - TTY accepts → DELETE proceeds. (Calibration §7: clear CI.)
 *   - TTY declines → exit 2.
 *   - Validation: missing --project, non-numeric <id> / --project.
 *   - HTTP errors: 401, 5xx.
 *
 * Calibration §1 / §2 — every error class has an explicit exit-code assertion.
 * Calibration §7 — TTY-prompt tests clear CI explicitly.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksProjectRemoveHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-project-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks project remove — happy paths', () => {
  it('--yes: 200 → already_in_target_state: false', async () => {
    server.use(tasksProjectRemoveHandlers.ok(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; project_id: number; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.tasks.project.remove/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.project_id).toBe(42);
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('404 (not in project) → already_in_target_state: true (idempotent, yaml :1985)', async () => {
    server.use(tasksProjectRemoveHandlers.notFound(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('human mode: live cleared line', async () => {
    server.use(tasksProjectRemoveHandlers.ok(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #4567 removed from project #42');
  });

  it('human mode: already-removed line', async () => {
    server.use(tasksProjectRemoveHandlers.notFound(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('was already removed');
  });
});

// ---------------------------------------------------------------------------
//  403 — primary-project removal
// ---------------------------------------------------------------------------

describe('freelo tasks project remove — 403 (primary project)', () => {
  it('403 → exit 4, FORBIDDEN, hint redirects to `tasks delete`', async () => {
    server.use(tasksProjectRemoveHandlers.forbidden(4567, 42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Error envelopes go to stderr, not stdout.
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.hint_next ?? '').toContain('tasks delete');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks project remove — dry-run', () => {
  it('--dry-run: no wire call, no prompt, would.path echoes', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        task_id: number;
        project_id: number;
        would: { method: string; path: string };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.project_id).toBe(42);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe('/task/4567/projects/42');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation gate
// ---------------------------------------------------------------------------

describe('freelo tasks project remove — confirmation', () => {
  it('non-TTY without --yes → exit 2 (CONFIRMATION_REQUIRED)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('TTY accepts → DELETE proceeds, exit 0; prompt mentions task #4567 and project #42 (calibration §7)', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    server.use(tasksProjectRemoveHandlers.ok(4567, 42));
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
        'project',
        'remove',
        '4567',
        '--project',
        '42',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const env = parseFirstJson(stdout) as { data: { already_in_target_state: boolean } };
      expect(env.data.already_in_target_state).toBe(false);
      expect(captured).toContain('task #4567');
      expect(captured).toContain('project #42');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY declines → exit 2 (calibration §7)', async () => {
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
        'project',
        'remove',
        '4567',
        '--project',
        '42',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(captured).toContain('task #4567');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks project remove — validation', () => {
  it('missing --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('non-numeric <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      'abc',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('non-numeric --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      'abc',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('zero --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo tasks project remove — HTTP errors', () => {
  it('401 → exit 3 (AUTH_EXPIRED)', async () => {
    server.use(tasksProjectRemoveHandlers.unauthorized(4567, 42));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('5xx → exit 4 (SERVER_ERROR)', async () => {
    server.use(tasksProjectRemoveHandlers.serverError(4567, 42, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'remove',
      '4567',
      '--project',
      '42',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
