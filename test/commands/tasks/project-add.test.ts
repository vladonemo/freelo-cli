/**
 * End-to-end tests for `freelo tasks project add` (R38, spec 0052).
 *
 * Covers:
 *   - Happy path live (1 tasklist): envelope shape, wire body shape.
 *   - Happy path live (N tasklists): N requests, distinct child ids per assignment.
 *   - Dedup: --tasklist 100 --tasklist 100 → 1 POST, tasklist_ids: [100].
 *   - Dry-run: no wire call, dry_run: true, would.body.tasklist_ids echo.
 *   - Mid-fan-out 4xx: first POST succeeds, second 403 → exit 4 (FreeloApiError).
 *   - Validation: missing --tasklist, non-numeric <id>/--tasklist.
 *   - HTTP errors: 401, 403, 404, 5xx.
 *
 * Calibration §1 / §2 — every error class has an explicit exit-code assertion.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksProjectAddHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-project-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ---------------------------------------------------------------------------
//  Happy path
// ---------------------------------------------------------------------------

describe('freelo tasks project add — happy paths', () => {
  it('1 tasklist: --tasklist 100 → assignments length 1, child task echoed', async () => {
    server.use(tasksProjectAddHandlers.ok(4567, 9001, 'abc-001'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        tasklist_ids: number[];
        assignments: Array<{ tasklist_id: number; child_task_id: number; child_task_uuid: string }>;
      };
    };
    expect(env.schema).toBe('freelo.tasks.project.add/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.tasklist_ids).toEqual([100]);
    expect(env.data.assignments).toHaveLength(1);
    expect(env.data.assignments[0]).toEqual({
      tasklist_id: 100,
      child_task_id: 9001,
      child_task_uuid: 'abc-001',
    });
  });

  it('N tasklists: --tasklist 100 --tasklist 200 → 2 assignments with distinct child ids', async () => {
    server.use(
      tasksProjectAddHandlers.okPerTasklist(4567, {
        100: { childTaskId: 9001, childUuid: 'abc-001' },
        200: { childTaskId: 9002, childUuid: 'abc-002' },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        tasklist_ids: number[];
        assignments: Array<{ tasklist_id: number; child_task_id: number }>;
      };
    };
    expect(env.data.tasklist_ids).toEqual([100, 200]);
    expect(env.data.assignments).toHaveLength(2);
    expect(env.data.assignments[0]?.tasklist_id).toBe(100);
    expect(env.data.assignments[0]?.child_task_id).toBe(9001);
    expect(env.data.assignments[1]?.tasklist_id).toBe(200);
    expect(env.data.assignments[1]?.child_task_id).toBe(9002);
  });

  it('dedup: --tasklist 100 --tasklist 100 → 1 POST, tasklist_ids: [100]', async () => {
    server.use(tasksProjectAddHandlers.ok(4567, 9001, 'abc-001'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { tasklist_ids: number[]; assignments: unknown[] };
    };
    // Dedup happens at the command layer; the envelope echoes the deduplicated ids.
    expect(env.data.tasklist_ids).toEqual([100]);
    expect(env.data.assignments).toHaveLength(1);
  });

  it('wire body is { tasklist_id: <int> } per call', async () => {
    const captured: unknown[] = [];
    server.use(tasksProjectAddHandlers.okCapturing(4567, captured));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toEqual([{ tasklist_id: 100 }, { tasklist_id: 200 }]);
  });

  it('human mode renders one terse line', async () => {
    server.use(
      tasksProjectAddHandlers.okPerTasklist(4567, {
        100: { childTaskId: 9001, childUuid: 'abc-001' },
        200: { childTaskId: 9002, childUuid: 'abc-002' },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '200',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #4567');
    expect(stdout).toContain('2 project(s)');
    expect(stdout).toContain('#100');
    expect(stdout).toContain('#200');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks project add — dry-run', () => {
  it('--dry-run: no wire call; dry_run=true; would.body.tasklist_ids echoed', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '200',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        task_id: number;
        tasklist_ids: number[];
        assignments?: unknown;
        would: { method: string; path: string; body: { tasklist_ids: number[] } };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.tasklist_ids).toEqual([100, 200]);
    expect(env.data.assignments).toBeUndefined();
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/4567/projects');
    expect(env.data.would.body.tasklist_ids).toEqual([100, 200]);
  });

  it('dry-run with single tasklist: would.body.tasklist_ids: [100]', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: { tasklist_ids: number[] } } };
    };
    expect(env.data.would.body.tasklist_ids).toEqual([100]);
  });
});

// ---------------------------------------------------------------------------
//  Mid-fan-out failure
// ---------------------------------------------------------------------------

describe('freelo tasks project add — mid-fan-out failure', () => {
  it('first POST succeeds, second 403 → exit 4 (FreeloApiError)', async () => {
    server.use(tasksProjectAddHandlers.okThen403(4567, 9001, 'abc-001'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--tasklist',
      '200',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Error envelopes go to stderr, not stdout (json mode).
    const env = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('FORBIDDEN');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks project add — validation', () => {
  it('missing --tasklist → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'project', 'add', '4567', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('non-numeric <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      'abc',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('zero <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '0',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('non-numeric --tasklist → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo tasks project add — HTTP errors', () => {
  it('401 → exit 3 (AUTH_EXPIRED)', async () => {
    server.use(tasksProjectAddHandlers.unauthorized(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4 (FORBIDDEN)', async () => {
    server.use(tasksProjectAddHandlers.forbidden(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4 (NOT_FOUND)', async () => {
    server.use(tasksProjectAddHandlers.notFound(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4 (SERVER_ERROR)', async () => {
    server.use(tasksProjectAddHandlers.serverError(4567, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'project',
      'add',
      '4567',
      '--tasklist',
      '100',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
