/**
 * End-to-end tests for `freelo projects delete` (R30, spec 0043).
 *
 * Mirrors the matrix in `test/commands/tasks/delete.test.ts` (R13). Per-
 * resource adjustments:
 *   - Wire path is `/project/{id}` instead of `/task/{id}`.
 *   - The TTY confirmation copy mentions "soft-delete" and
 *     "freelo projects activate" (decision 6).
 *   - Per-line context key is `project_id`.
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: every typed error class triggers a test.
 * Calibration §4: the new try/catch arms (404 re-classify; toBaseError
 *   fallback) have explicit coverage.
 * Calibration §7: any test asserting TTY-prompt copy clears `process.env['CI']`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeAll, beforeEach, afterAll, describe, expect, it, vi } from 'vitest';
import { server, projectsDeleteHandlers } from '../../msw/handlers.js';

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

function parseAllJson(text: string): Array<Record<string, unknown>> {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-projects-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo projects delete — happy paths', () => {
  it('single id with --yes → success envelope, exit 0', async () => {
    server.use(projectsDeleteHandlers.deleteOk(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; current_state: string; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.projects.delete/v1');
    expect(env.data.project_id).toBe(9001);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi-id positional with --yes → 3 envelopes, exit 0', async () => {
    server.use(
      projectsDeleteHandlers.deleteOk(9001),
      projectsDeleteHandlers.deleteOk(9002),
      projectsDeleteHandlers.deleteOk(9003),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '9002',
      '9003',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(parseAllJson(stdout)).toHaveLength(3);
  });

  it('human mode renders the success line', async () => {
    server.use(projectsDeleteHandlers.deleteOk(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Deleted project #9001.');
  });

  it('NDJSON batch with --yes → ordered output with line_index', async () => {
    server.use(projectsDeleteHandlers.deleteOk(100), projectsDeleteHandlers.deleteOk(200));

    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['{"id":100}\n{"id":200}\n']);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[0]).toMatchObject({
      schema: 'freelo.projects.delete/v1',
      data: { project_id: 100, current_state: 'deleted', line_index: 0 },
    });
    expect(envs[1]).toMatchObject({
      schema: 'freelo.projects.delete/v1',
      data: { project_id: 200, current_state: 'deleted', line_index: 1 },
    });
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects delete — dry-run', () => {
  it('--dry-run: no HTTP, no confirm; envelope has dry_run + would', async () => {
    // No MSW handler — the test asserts no HTTP fired.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
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
        already_in_target_state: boolean;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.projects.delete/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.would).toEqual({
      method: 'DELETE',
      path: '/project/9001',
      body: {},
    });
  });
});

// ---------------------------------------------------------------------------
//  404 → idempotent already-deleted (calibration §4)
// ---------------------------------------------------------------------------

describe('freelo projects delete — idempotent re-delete', () => {
  it('404 → already_in_target_state: true, exit 0', async () => {
    server.use(projectsDeleteHandlers.deleteNotFound(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; current_state: string; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.projects.delete/v1');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('human mode says "was already deleted"', async () => {
    server.use(projectsDeleteHandlers.deleteNotFound(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Project #9001 was already deleted.');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation gate
// ---------------------------------------------------------------------------

describe('freelo projects delete — confirmation', () => {
  it('non-TTY without --yes → exit 2 (CONFIRMATION_REQUIRED), no HTTP', async () => {
    // No MSW handler — if a request escapes, MSW errors.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('confirmation copy mentions "soft-delete" and "projects activate" in TTY mode', async () => {
    // Calibration §7: GitHub Actions sets CI=true which makes isInteractive()
    // return false regardless of isTTY. Clear it so the TTY-prompt branch runs.
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
      const { exitCode } = await runCli(run, ['projects', 'delete', '9001', '--output', 'json']);
      expect(exitCode).toBe(2);
      expect(captured).toContain('soft-delete');
      expect(captured).toContain('projects activate');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY user declines → exit 2, no HTTP', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(false),
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['projects', 'delete', '9001', '--output', 'json']);
      expect(exitCode).toBe(2);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo projects delete — validation', () => {
  it('bad <id> (zero) → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('combining positional + --ids → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--ids',
      '9002',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one input source|VALIDATION/);
  });

  it('no input sources → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'delete', '--yes', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('empty stdin with --yes → silent exit 0', async () => {
    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['']);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
//  API errors
// ---------------------------------------------------------------------------

describe('freelo projects delete — api errors', () => {
  it('401 → exit 3', async () => {
    server.use(projectsDeleteHandlers.deleteUnauthorized(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(projectsDeleteHandlers.deleteForbidden(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('422 → exit 4', async () => {
    server.use(projectsDeleteHandlers.deleteUnprocessable(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6, retryable', async () => {
    server.use(projectsDeleteHandlers.deleteRateLimited(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toMatch(/RATE_LIMITED|"retryable":true/);
  });

  it('5xx → exit 4', async () => {
    server.use(projectsDeleteHandlers.deleteServerError(9001, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network error → exit 5', async () => {
    server.use(projectsDeleteHandlers.deleteNetworkError(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Human-mode batch coverage (calibration §4 — writeBatchError human branch)
// ---------------------------------------------------------------------------

describe('freelo projects delete — human renderers', () => {
  it('multi-id human mode with mid-batch error prints "Failed item N (project #ID): …"', async () => {
    server.use(projectsDeleteHandlers.deleteOk(9001), projectsDeleteHandlers.deleteForbidden(9002));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '9002',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain('Deleted project #9001.');
    expect(stdout).toMatch(/Failed item 2 \(project #9002\):/);
  });

  it('stdin batch with mid-line FORBIDDEN → per-line error envelope with line_index', async () => {
    server.use(projectsDeleteHandlers.deleteOk(100), projectsDeleteHandlers.deleteForbidden(200));

    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['{"id":100}\n{"id":200}\n']);
    Object.defineProperty(process, 'stdin', { configurable: true, value: fakeStdin });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[1]?.['schema']).toBe('freelo.error/v1');
    const ctx = (envs[1]?.['error'] as { context: Record<string, number> }).context;
    expect(ctx['line_index']).toBe(1);
    expect(ctx['project_id']).toBe(200);
  });

  it('stdin batch with malformed NDJSON line → per-line VALIDATION_ERROR envelope', async () => {
    server.use(projectsDeleteHandlers.deleteOk(100));

    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['not json\n{"id":100}\n']);
    Object.defineProperty(process, 'stdin', { configurable: true, value: fakeStdin });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2); // VALIDATION_ERROR dominates over 0 success
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[0]?.['schema']).toBe('freelo.error/v1');
    expect(envs[1]?.['schema']).toBe('freelo.projects.delete/v1');
  });

  it('multi-id with NetworkError → batch error envelope omits errors[] field', async () => {
    server.use(
      projectsDeleteHandlers.deleteOk(9001),
      projectsDeleteHandlers.deleteNetworkError(9002),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '9002',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5); // NETWORK_ERROR dominates 0
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[1]?.['schema']).toBe('freelo.error/v1');
    // NetworkError carries no `errors[]` — exercises the undefined branch in
    // writeBatchError (delete.ts:477).
    expect((envs[1]?.['error'] as Record<string, unknown>)['errors']).toBeUndefined();
  });

  it('--dry-run human mode prints "Would delete project #ID."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would delete project #9001.');
  });
});

// ---------------------------------------------------------------------------
//  Multi-id error semantics (calibration §4 — toBaseError fallback path is
//  exercised here when batch errors flow through writeBatchError)
// ---------------------------------------------------------------------------

describe('freelo projects delete — multi-id error semantics', () => {
  it('mixed 200/404/403 → 3 envelopes, exit 4 (highest)', async () => {
    server.use(
      projectsDeleteHandlers.deleteOk(9001),
      projectsDeleteHandlers.deleteNotFound(9002), // idempotent → success
      projectsDeleteHandlers.deleteForbidden(9003),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'delete',
      '9001',
      '9002',
      '9003',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4); // FORBIDDEN dominates 0s
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(3);
    expect(envs[0]?.['schema']).toBe('freelo.projects.delete/v1');
    // 9002 is the 404-idempotent path; success envelope, not error envelope.
    expect(envs[1]?.['schema']).toBe('freelo.projects.delete/v1');
    expect(
      (envs[1]?.['data'] as { already_in_target_state: boolean }).already_in_target_state,
    ).toBe(true);
    expect(envs[2]?.['schema']).toBe('freelo.error/v1');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects delete — introspect', () => {
  it('--introspect lists `projects delete` with output schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects delete');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.delete/v1');
    expect(cmd?.destructive).toBe(true);
  });
});
