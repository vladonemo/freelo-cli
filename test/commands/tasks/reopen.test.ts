/**
 * End-to-end tests for `freelo tasks reopen` (R11, spec 0021).
 *
 * Thinner companion to `finish.test.ts`: the shared infra (parsing, batch
 * loop, idempotency helper) is exercised there; this file pins down the
 * verb-specific behavior — the wire path is `/task/{id}/activate`, the target
 * state is `'active'`, and natural API idempotency is documented (OpenAPI
 * :1802) so an already-active task short-circuits before the POST.
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: each typed error class touched by R11's reopen path has a
 * triggering test (ValidationError, FreeloApiError).
 */

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
    /* swallow */
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
    `freelo-tasks-reopen-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks reopen — happy paths', () => {
  it('finished → active: JSON envelope, exit 0', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(
      tasksShowHandlers.detailOk(9012, taskFinished),
      tasksTransitionHandlers.activateOk(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'reopen', '9012', '--output', 'json']);

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
    expect(env.schema).toBe('freelo.tasks.reopen/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.previous_state).toBe('finished');
    expect(env.data.current_state).toBe('active');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.verb).toBe('reopen');
  });

  it('idempotent skip: already active → no POST, already_in_target_state: true', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    // No /activate POST handler — a POST would fail the test (unhandled).
    server.use(tasksShowHandlers.detailOk(9012, taskActive));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'reopen', '9012', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        previous_state: string;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.data.previous_state).toBe('active');
    expect(env.data.current_state).toBe('active');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('--dry-run on finished task: pre-check runs, no POST, would present', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(tasksShowHandlers.detailOk(9012, taskFinished));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'reopen',
      '9012',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        previous_state: string;
        current_state: string;
        would: { method: string; path: string };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.previous_state).toBe('finished');
    expect(env.data.current_state).toBe('finished');
    expect(env.data.would.path).toBe('/task/9012/activate');
  });

  it('human mode renders the success line', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(
      tasksShowHandlers.detailOk(9012, taskFinished),
      tasksTransitionHandlers.activateOk(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'reopen',
      '9012',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Reopened task #9012');
    expect(stdout).toContain('was finished');
  });
});

describe('freelo tasks reopen — error paths', () => {
  it('pre-check shows deleted task → VALIDATION_ERROR exit 2', async () => {
    const taskActive = await loadFixture<Record<string, unknown>>('transition-9012-active.json');
    const deletedFixture = { ...taskActive, state: { id: 4, state: 'deleted' } };
    server.use(tasksShowHandlers.detailOk(9012, deletedFixture));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'reopen', '9012', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/deleted/);
  });

  it('POST 403 → FORBIDDEN exit 4', async () => {
    const taskFinished = await loadFixture<Record<string, unknown>>(
      'transition-9012-finished.json',
    );
    server.use(
      tasksShowHandlers.detailOk(9012, taskFinished),
      tasksTransitionHandlers.activateForbidden(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'reopen', '9012', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
  });

  it('non-numeric positional id → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'reopen', 'oops', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo tasks reopen — introspect', () => {
  it('shows up in --introspect with the right schema and destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const reopen = env.data.commands.find((c) => c.name === 'tasks reopen');
    expect(reopen).toBeDefined();
    expect(reopen!.output_schema).toBe('freelo.tasks.reopen/v1');
    expect(reopen!.destructive).toBe(false);
  });
});
