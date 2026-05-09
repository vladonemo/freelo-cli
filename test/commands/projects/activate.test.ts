/**
 * End-to-end tests for `freelo projects activate` (R30, spec 0043).
 *
 * The command shares its orchestration with `projects archive` via
 * `src/commands/projects/transition.ts`, so this file focuses on the
 * `activate`-specific differences (schema discriminant, target state, plus
 * the documented `PlanExceededException` 422 path).
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: every typed error class has a triggering test.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { server, projectsTransitionHandlers } from '../../msw/handlers.js';

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-projects-activate-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects activate — happy paths', () => {
  it('single id → JSON envelope, current_state: active, exit 0', async () => {
    server.use(projectsTransitionHandlers.ok('activate', 9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'activate',
      '9001',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; current_state: string };
    };
    expect(env.schema).toBe('freelo.projects.activate/v1');
    expect(env.data.project_id).toBe(9001);
    expect(env.data.current_state).toBe('active');
  });

  it('human mode renders the success line', async () => {
    server.use(projectsTransitionHandlers.ok('activate', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'activate',
      '9001',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Activated project #9001.');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects activate — dry-run', () => {
  it('--dry-run: would.method=POST, path=/project/9001/activate', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'activate',
      '9001',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        project_id: number;
        current_state: string;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.projects.activate/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/project/9001/activate',
      body: {},
    });
  });
});

// ---------------------------------------------------------------------------
//  PlanExceededException — the activate-specific 422 path (decision 8)
// ---------------------------------------------------------------------------

describe('freelo projects activate — plan-exceeded (422)', () => {
  it('PlanExceededException 422 → exit 4, server message in errors[]', async () => {
    server.use(
      projectsTransitionHandlers.unprocessable(
        'activate',
        9001,
        'PlanExceededException: project cap reached',
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'activate',
      '9001',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stderr).toContain('PlanExceededException');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo projects activate — validation', () => {
  it('bad <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'activate', 'abc', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  API errors (smoke-coverage; archive.test covers the full matrix)
// ---------------------------------------------------------------------------

describe('freelo projects activate — api errors', () => {
  it('401 → exit 3', async () => {
    server.use(projectsTransitionHandlers.unauthorized('activate', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'activate', '9001', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('404 → exit 4 (NOT_FOUND, not idempotent on activate)', async () => {
    server.use(projectsTransitionHandlers.notFound('activate', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'activate', '9001', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('network error → exit 5', async () => {
    server.use(projectsTransitionHandlers.networkError('activate', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'activate', '9001', '--output', 'json']);
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects activate — introspect', () => {
  it('--introspect lists `projects activate` with schema and non-destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects activate');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.activate/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
