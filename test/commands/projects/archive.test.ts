/**
 * End-to-end tests for `freelo projects archive` (R30, spec 0043).
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class (`ValidationError`, `FreeloApiError`,
 * `RateLimitedError`, `NetworkError`) has a triggering test.
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
    `freelo-projects-archive-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects archive — happy paths', () => {
  it('single positional id → JSON envelope, schema, exit 0', async () => {
    server.use(projectsTransitionHandlers.ok('archive', 9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; current_state: string };
    };
    expect(env.schema).toBe('freelo.projects.archive/v1');
    expect(env.data.project_id).toBe(9001);
    expect(env.data.current_state).toBe('archived');
  });

  it('positional batch (3 ids) → 3 envelopes, exit 0', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 9001),
      projectsTransitionHandlers.ok('archive', 9002),
      projectsTransitionHandlers.ok('archive', 9003),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '9002',
      '9003',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(3);
    expect(envs.map((e) => (e['data'] as { project_id: number }).project_id)).toEqual([
      9001, 9002, 9003,
    ]);
  });

  it('--ids "1,2,3" → 3 envelopes, exit 0', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 1),
      projectsTransitionHandlers.ok('archive', 2),
      projectsTransitionHandlers.ok('archive', 3),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--ids',
      '1,2,3',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(parseAllJson(stdout)).toHaveLength(3);
  });

  it('human mode renders the success line', async () => {
    server.use(projectsTransitionHandlers.ok('archive', 9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Archived project #9001.');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects archive — dry-run', () => {
  it('--dry-run: no HTTP, envelope carries dry_run + would', async () => {
    // No MSW handler — the test asserts no HTTP fired (MSW would error).
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
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
    expect(env.schema).toBe('freelo.projects.archive/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.project_id).toBe(9001);
    expect(env.data.current_state).toBe('archived');
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/project/9001/archive',
      body: {},
    });
  });
});

// ---------------------------------------------------------------------------
//  Stdin batch (NDJSON)
// ---------------------------------------------------------------------------

describe('freelo projects archive — stdin', () => {
  it('NDJSON in → ordered NDJSON out with line_index', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 100),
      projectsTransitionHandlers.ok('archive', 200),
    );

    // Inject stdin via a Readable. We mirror the convention used by the
    // tasks/finish.test.ts: replace process.stdin with a fake stream.
    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['{"id":100}\n{"id":200}\n']);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[0]).toMatchObject({
      schema: 'freelo.projects.archive/v1',
      data: { project_id: 100, current_state: 'archived', line_index: 0 },
    });
    expect(envs[1]).toMatchObject({
      schema: 'freelo.projects.archive/v1',
      data: { project_id: 200, current_state: 'archived', line_index: 1 },
    });
  });

  it('--stdin + --dry-run: per-line dry-run envelopes, no HTTP', async () => {
    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['{"id":100}\n{"id":200}\n']);
    Object.defineProperty(process, 'stdin', { configurable: true, value: fakeStdin });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--stdin',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[0]).toMatchObject({
      schema: 'freelo.projects.archive/v1',
      dry_run: true,
      data: { project_id: 100, line_index: 0 },
    });
    expect(envs[1]).toMatchObject({
      schema: 'freelo.projects.archive/v1',
      dry_run: true,
      data: { project_id: 200, line_index: 1 },
    });
  });

  it('empty stdin → silent exit 0 (no envelopes)', async () => {
    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['']);
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: fakeStdin,
    });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo projects archive — validation', () => {
  it('bad <id> (zero) → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('--ids "" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--ids',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('combining positional + --ids → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '--ids',
      '9002',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one input source|VALIDATION/);
  });
});

// ---------------------------------------------------------------------------
//  API errors
// ---------------------------------------------------------------------------

describe('freelo projects archive — api errors', () => {
  it('401 → exit 3 (AUTH_EXPIRED)', async () => {
    server.use(projectsTransitionHandlers.unauthorized('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4 (FORBIDDEN)', async () => {
    server.use(projectsTransitionHandlers.forbidden('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4 (NOT_FOUND, not idempotent on archive)', async () => {
    server.use(projectsTransitionHandlers.notFound('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('422 → exit 4 (FREELO_API_ERROR)', async () => {
    server.use(projectsTransitionHandlers.unprocessable('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6 (RATE_LIMITED), retryable', async () => {
    server.use(projectsTransitionHandlers.rateLimited('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toMatch(/RATE_LIMITED|"retryable":true/);
  });

  it('5xx → exit 4 (FREELO_API_ERROR), retryable', async () => {
    server.use(projectsTransitionHandlers.serverError('archive', 9001, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('network error → exit 5 (NETWORK_ERROR)', async () => {
    server.use(projectsTransitionHandlers.networkError('archive', 9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'archive', '9001', '--output', 'json']);
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Renderers (human-mode coverage for dry-run + batch failure paths)
// ---------------------------------------------------------------------------

describe('freelo projects archive — human renderers', () => {
  it('--dry-run human mode prints "Would archive project #ID."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would archive project #9001.');
  });

  it('multi-id human mode with mid-batch error prints "Failed item N (id=ID): …"', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 9001),
      projectsTransitionHandlers.forbidden('archive', 9002),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '9002',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain('Archived project #9001.');
    expect(stdout).toMatch(/Failed item 2 \(id=9002\):/);
  });

  it('stdin batch mid-line FORBIDDEN → per-line error envelope with line_index, exit 4', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 100),
      projectsTransitionHandlers.forbidden('archive', 200),
    );

    const { Readable } = await import('node:stream');
    const fakeStdin = Readable.from(['{"id":100}\n{"id":200}\n']);
    Object.defineProperty(process, 'stdin', { configurable: true, value: fakeStdin });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[0]?.['schema']).toBe('freelo.projects.archive/v1');
    expect(envs[1]?.['schema']).toBe('freelo.error/v1');
    const ctx = (envs[1]?.['error'] as { context: Record<string, number> }).context;
    expect(ctx['line_index']).toBe(1); // fromStdin: true branch
    expect(ctx['project_id']).toBe(200);
  });
});

// ---------------------------------------------------------------------------
//  Multi-id error semantics
// ---------------------------------------------------------------------------

describe('freelo projects archive — multi-id error semantics', () => {
  it('multi-id with NetworkError → error envelope omits errors[] field', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 9001),
      projectsTransitionHandlers.networkError('archive', 9002),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '9002',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5); // NETWORK_ERROR dominates 0
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(2);
    expect(envs[1]?.['schema']).toBe('freelo.error/v1');
    // NetworkError carries no `errors[]` field — exercises the undefined
    // branch in writeBatchError (transition.ts:508).
    expect((envs[1]?.['error'] as Record<string, unknown>)['errors']).toBeUndefined();
  });

  it('mixed success/error → per-id envelopes, max exit code', async () => {
    server.use(
      projectsTransitionHandlers.ok('archive', 9001),
      projectsTransitionHandlers.forbidden('archive', 9002),
      projectsTransitionHandlers.ok('archive', 9003),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'archive',
      '9001',
      '9002',
      '9003',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4); // FORBIDDEN dominates 0s
    const envs = parseAllJson(stdout);
    expect(envs).toHaveLength(3);
    expect(envs[0]?.['schema']).toBe('freelo.projects.archive/v1');
    expect(envs[1]?.['schema']).toBe('freelo.error/v1');
    expect(envs[2]?.['schema']).toBe('freelo.projects.archive/v1');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects archive — introspect', () => {
  it('--introspect lists `projects archive` with output schema and destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects archive');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.archive/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
