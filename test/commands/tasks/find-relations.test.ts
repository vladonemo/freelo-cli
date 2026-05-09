/**
 * End-to-end tests for `freelo tasks find-relations` (R38, spec 0052).
 *
 * Read-only bulk relations query. Covers:
 *   - Happy path: all visible.
 *   - Inaccessible task: tasks length < task_ids length.
 *   - Dedup --task 1 --task 1 → task_ids: [1].
 *   - Wire body shape: { task_ids: [...] }.
 *   - Validation: missing --task, 101 task ids, non-numeric --task, zero --task.
 *   - HTTP: 401, 5xx.
 *   - Human mode summary line ("queried, visible").
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksFindRelationsHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-find-relations-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks find-relations — happy paths', () => {
  it('all visible: tasks length == task_ids length', async () => {
    server.use(
      tasksFindRelationsHandlers.ok([
        {
          task_id: 4567,
          relations: [{ type: 'blocks', related_task_id: 9876, related_task_name: 'X' }],
        },
        { task_id: 4568, relations: [] },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--task',
      '4568',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_ids: number[];
        tasks: Array<{ task_id: number; relations: unknown[] }>;
      };
    };
    expect(env.schema).toBe('freelo.tasks.find-relations/v1');
    expect(env.data.task_ids).toEqual([4567, 4568]);
    expect(env.data.tasks).toHaveLength(2);
    expect(env.data.tasks[0]?.task_id).toBe(4567);
    expect(env.data.tasks[0]?.relations).toHaveLength(1);
    expect(env.data.tasks[1]?.task_id).toBe(4568);
    expect(env.data.tasks[1]?.relations).toEqual([]);
  });

  it('inaccessible task: tasks length < task_ids length (server omits silently)', async () => {
    // Caller asks for [4567, 4568, 4569]; server returns only [4567, 4568].
    server.use(
      tasksFindRelationsHandlers.ok([
        { task_id: 4567, relations: [] },
        { task_id: 4568, relations: [] },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--task',
      '4568',
      '--task',
      '4569',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task_ids: number[]; tasks: Array<{ task_id: number }> };
    };
    expect(env.data.task_ids).toEqual([4567, 4568, 4569]);
    expect(env.data.tasks).toHaveLength(2);
    const visibleIds = env.data.tasks.map((t) => t.task_id);
    expect(visibleIds).toEqual([4567, 4568]);
  });

  it('dedup: --task 4567 --task 4567 → task_ids: [4567]', async () => {
    server.use(
      tasksFindRelationsHandlers.okWhenBody(
        (body: unknown) => {
          const b = body as { task_ids?: unknown };
          return Array.isArray(b.task_ids) && b.task_ids.length === 1 && b.task_ids[0] === 4567;
        },
        [{ task_id: 4567, relations: [] }],
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--task',
      '4567',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { task_ids: number[] } };
    expect(env.data.task_ids).toEqual([4567]);
  });

  it('wire body: { task_ids: [4567, 4568] }', async () => {
    let captured: unknown;
    server.use(
      tasksFindRelationsHandlers.okWhenBody(
        (body: unknown) => {
          captured = body;
          return true;
        },
        [
          { task_id: 4567, relations: [] },
          { task_id: 4568, relations: [] },
        ],
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--task',
      '4568',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_ids: [4567, 4568] });
  });

  it('human mode: summary line shows "queried, visible"', async () => {
    server.use(
      tasksFindRelationsHandlers.ok([
        {
          task_id: 4567,
          relations: [{ type: 'blocks', related_task_id: 9876, related_task_name: 'X' }],
        },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--task',
      '4568',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('2 task(s) queried');
    expect(stdout).toContain('1 visible');
    expect(stdout).toContain('#4567');
  });
});

describe('freelo tasks find-relations — validation', () => {
  it('missing --task → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'find-relations', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('101 --task ids → exit 2 (max 100)', async () => {
    const args = ['tasks', 'find-relations'];
    for (let i = 1; i <= 101; i += 1) {
      args.push('--task', String(i));
    }
    args.push('--output', 'json');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, args);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain('100');
  });

  it('non-numeric --task → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('zero --task → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo tasks find-relations — HTTP errors', () => {
  it('401 → exit 3', async () => {
    server.use(tasksFindRelationsHandlers.unauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('5xx → exit 4', async () => {
    server.use(tasksFindRelationsHandlers.serverError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'find-relations',
      '--task',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
