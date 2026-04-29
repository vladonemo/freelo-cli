/**
 * End-to-end tests for `freelo task-labels create` (R24, spec 0036).
 *
 * One bulk POST per command (no fan-out — spec 0036 decision 05). Server
 * is fetch-or-create; CLI cannot tell new from reused.
 *
 * Covers:
 *   - Happy paths: single name, multi-name with --hex, JSON envelope, human output, dry-run
 *   - Validation: missing --name, empty --name, bad --hex (Calibration §2 exit-code assertions)
 *   - HTTP errors: 5xx → FreeloApiError exit 4
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';

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
    `freelo-task-labels-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo task-labels create — happy paths', () => {
  it('single --name: one POST, exit 0, envelope shape', async () => {
    server.use(
      taskLabelsHandlers.createOkWhenBody((body) => {
        const b = body as { labels?: Array<{ name?: string }> };
        return Array.isArray(b.labels) && b.labels.length === 1 && b.labels[0]?.name === 'Bug';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { labels: Array<{ name?: string }>; count: number };
    };
    expect(env.schema).toBe('freelo.task_labels.create/v1');
    expect(env.data.count).toBe(1);
    expect(env.data.labels[0]?.name).toBe('Bug');
  });

  it('multiple --name + --hex: every entry has the same color', async () => {
    server.use(
      taskLabelsHandlers.createOkWhenBody((body) => {
        const b = body as { labels?: Array<{ name?: string; color?: string }> };
        if (!Array.isArray(b.labels) || b.labels.length !== 2) return false;
        return b.labels.every((l) => l.color === '#9b59b6');
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--name',
      'Wip',
      '--hex',
      '#9b59b6',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { count: number; labels: Array<{ color?: string }> };
    };
    expect(env.data.count).toBe(2);
    expect(env.data.labels[0]?.color).toBe('#9b59b6');
    expect(env.data.labels[1]?.color).toBe('#9b59b6');
  });

  it('--dry-run: no MSW request fires; envelope echoes would', async () => {
    let hit = 0;
    server.use(
      taskLabelsHandlers.createOkWhenBody(() => {
        hit += 1;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(hit).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/task-labels');
  });

  it('human output: prints "Created or matched ..."', async () => {
    server.use(taskLabelsHandlers.createOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created or matched');
    expect(stdout).toContain('Bug');
  });
});

describe('freelo task-labels create — validation', () => {
  it('no --name → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/--name|VALIDATION/);
  });

  it('empty --name (whitespace only) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --hex (3-digit) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--hex',
      '#abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo task-labels create — error paths (Calibration §2)', () => {
  it('5xx → FreeloApiError exit 4', async () => {
    server.use(taskLabelsHandlers.createServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'create',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
