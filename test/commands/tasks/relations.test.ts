/**
 * End-to-end tests for `freelo tasks relations` (R38, spec 0052).
 *
 * Read-only single-id command. Covers:
 *   - Happy path 200 with relations array.
 *   - Happy path 200 empty array.
 *   - null `related_task_name` (server occasionally returns null for orphaned refs).
 *   - Validation: non-numeric / zero <id>.
 *   - HTTP: 401, 403, 404, 5xx.
 *   - Human mode lines.
 *
 * No --dry-run flag (decision 5 — read-only).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksRelationsHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-relations-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasks relations — happy paths', () => {
  it('200 with relations: envelope carries them', async () => {
    server.use(
      tasksRelationsHandlers.ok(4567, [
        { type: 'blocks', related_task_id: 9876, related_task_name: 'Ship the thing' },
        { type: 'related_to', related_task_id: 9877, related_task_name: 'Other thing' },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'relations',
      '4567',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        relations: Array<{
          type: string;
          related_task_id: number;
          related_task_name: string | null;
        }>;
      };
    };
    expect(env.schema).toBe('freelo.tasks.relations/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.relations).toHaveLength(2);
    expect(env.data.relations[0]?.type).toBe('blocks');
    expect(env.data.relations[0]?.related_task_id).toBe(9876);
  });

  it('200 with empty relations: envelope `relations: []`', async () => {
    server.use(tasksRelationsHandlers.ok(4567, []));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'relations',
      '4567',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { relations: unknown[] };
    };
    expect(env.data.relations).toEqual([]);
  });

  it('200 with null related_task_name: still parses (orphaned ref defensive)', async () => {
    server.use(
      tasksRelationsHandlers.ok(4567, [
        { type: 'duplicate_of', related_task_id: 9999, related_task_name: null },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'relations',
      '4567',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { relations: Array<{ related_task_name: string | null }> };
    };
    expect(env.data.relations[0]?.related_task_name).toBeNull();
  });

  it('human mode: relations listed', async () => {
    server.use(
      tasksRelationsHandlers.ok(4567, [
        { type: 'blocks', related_task_id: 9876, related_task_name: 'Ship the thing' },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'relations',
      '4567',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #4567');
    expect(stdout).toContain('1 relation(s)');
    expect(stdout).toContain('blocks');
    expect(stdout).toContain('#9876');
  });

  it('human mode: no relations line', async () => {
    server.use(tasksRelationsHandlers.ok(4567, []));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'relations',
      '4567',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no relations');
  });
});

describe('freelo tasks relations — validation', () => {
  it('non-numeric <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', 'abc', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('zero <id> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo tasks relations — HTTP errors', () => {
  it('401 → exit 3', async () => {
    server.use(tasksRelationsHandlers.unauthorized(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', '4567', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(tasksRelationsHandlers.forbidden(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4', async () => {
    server.use(tasksRelationsHandlers.notFound(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(tasksRelationsHandlers.serverError(4567, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'relations', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });
});
