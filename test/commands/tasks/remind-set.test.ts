/**
 * End-to-end tests for `freelo tasks remind set` (R35, spec 0049).
 *
 * Covers:
 *   - Happy path live: envelope shape, wire body, UTC normalization.
 *   - Dry-run: no wire call, `dry_run: true`, `would.body.remind_at` echo.
 *   - Validation: malformed --at, empty --at, past --at, missing --at, bad <id>.
 *   - HTTP errors: 401 / 403 / 404 / 5xx.
 *   - Server response missing `task.name` → envelope `task_name: null`.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class triggers explicitly
 * (`ValidationError` exit 2, `FreeloApiError` exit 3 for 401, exit 4 for 403/404/5xx).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksRemindSetHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-remind-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks remind set — happy paths', () => {
  it('live: --at canonical UTC → envelope reflects server response', async () => {
    server.use(
      tasksRemindSetHandlers.ok(4567, {
        remind_at: '2099-01-01T09:00:00Z',
        task: { id: 4567, name: 'Review PR' },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; task_name: string | null; remind_at: string };
    };
    expect(env.schema).toBe('freelo.tasks.remind.set/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.task_name).toBe('Review PR');
    expect(env.data.remind_at).toBe('2099-01-01T09:00:00Z');
  });

  it('live: tz-offset --at is normalized to UTC on the wire', async () => {
    let captured: unknown;
    server.use(
      tasksRemindSetHandlers.okWhenBody(
        4567,
        (body) => {
          captured = body;
          const b = body as { remind_at?: string };
          return b.remind_at === '2099-01-01T09:00:00Z';
        },
        { remind_at: '2099-01-01T09:00:00Z', task: { id: 4567, name: 'Review PR' } },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T11:00:00+02:00',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toEqual({ remind_at: '2099-01-01T09:00:00Z' });
  });

  it('live: server response without task.name → envelope task_name: null', async () => {
    server.use(
      tasksRemindSetHandlers.ok(4567, {
        remind_at: '2099-01-01T09:00:00Z',
        task: { id: 4567 }, // no name
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { task_name: string | null } };
    expect(env.data.task_name).toBeNull();
  });

  it('human mode renders one terse line', async () => {
    server.use(
      tasksRemindSetHandlers.ok(4567, {
        remind_at: '2099-01-01T09:00:00Z',
        task: { id: 4567, name: 'Review PR' },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Reminder set on task #4567');
    expect(stdout).toContain('"Review PR"');
    expect(stdout).toContain('2099-01-01T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks remind set — dry-run', () => {
  it('--dry-run: no wire call, envelope dry_run=true, would.body.remind_at echoed', async () => {
    // No handler — a wire call would fail with onUnhandledRequest: 'error'.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
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
        remind_at: string;
        would: { method: string; path: string; body: { remind_at: string } };
      };
    };
    expect(env.schema).toBe('freelo.tasks.remind.set/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.remind_at).toBe('2099-01-01T09:00:00Z');
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/4567/reminder');
    expect(env.data.would.body.remind_at).toBe('2099-01-01T09:00:00Z');
  });

  it('--dry-run + tz-offset --at canonicalizes in would.body.remind_at', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T11:00:00+02:00',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: { remind_at: string } } };
    };
    expect(env.data.would.body.remind_at).toBe('2099-01-01T09:00:00Z');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks remind set — validation', () => {
  it('missing --at → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('--at is required');
  });

  it('malformed --at → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      'not a date',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('empty --at → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--at in the past (1970) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '1970-01-01T00:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('past');
  });

  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      'abc',
      '--at',
      '2099-01-01T09:00:00Z',
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
      'set',
      '0',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths
// ---------------------------------------------------------------------------

describe('freelo tasks remind set — HTTP errors', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksRemindSetHandlers.unauthorized(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → FORBIDDEN exit 4', async () => {
    server.use(tasksRemindSetHandlers.forbidden(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → NOT_FOUND exit 4', async () => {
    server.use(tasksRemindSetHandlers.notFound(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('500 → FREELO_API_ERROR exit 4', async () => {
    server.use(tasksRemindSetHandlers.serverError(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'remind',
      'set',
      '4567',
      '--at',
      '2099-01-01T09:00:00Z',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
