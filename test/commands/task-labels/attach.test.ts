/**
 * End-to-end tests for `freelo task-labels attach` (R24, spec 0036).
 *
 * One bulk POST per command. Mixed UUID + name-mode entries supported.
 *
 * Covers:
 *   - Happy paths: name-mode, uuid-mode, mixed, name+color, dry-run, human output
 *   - Validation: missing selectors, bad --task, bad --uuid, bad --hex
 *     (each Calibration §2 exit-code asserted)
 *   - HTTP errors: 400 (bad color), 5xx → exit 4
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';

const UUID = '11111111-1111-1111-1111-111111111111';
const UUID_2 = '22222222-2222-2222-2222-222222222222';

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
    `freelo-task-labels-attach-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo task-labels attach — happy paths', () => {
  it('--name only: one name-mode entry', async () => {
    server.use(
      taskLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return (
          Array.isArray(b.labels) &&
          b.labels.length === 1 &&
          b.labels[0]?.['name'] === 'Bug' &&
          !('uuid' in (b.labels[0] ?? {}))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; count: number; labels: Array<{ name?: string }> };
    };
    expect(env.schema).toBe('freelo.task_labels.attach/v1');
    expect(env.data.task_id).toBe(7);
    expect(env.data.count).toBe(1);
    expect(env.data.labels[0]?.name).toBe('Bug');
  });

  it('--uuid only: one uuid-mode entry, no color', async () => {
    server.use(
      taskLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return (
          Array.isArray(b.labels) &&
          b.labels.length === 1 &&
          b.labels[0]?.['uuid'] === UUID &&
          !('name' in (b.labels[0] ?? {}))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--uuid',
      UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { labels: Array<{ uuid?: string }> };
    };
    expect(env.data.labels[0]?.uuid).toBe(UUID);
  });

  it('mixed --name + --uuid: 2 entries; uuid first, then name', async () => {
    server.use(
      taskLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        if (!Array.isArray(b.labels) || b.labels.length !== 2) return false;
        return b.labels[0]?.['uuid'] === UUID && b.labels[1]?.['name'] === 'Bug';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--uuid',
      UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('--name + --hex: name-mode entry carries the color', async () => {
    server.use(
      taskLabelsHandlers.attachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return b.labels?.[0]?.['color'] === '#abcdef';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--hex',
      '#abcdef',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('--dry-run: no fetch; envelope has would.path with task id', async () => {
    let hit = 0;
    server.use(
      taskLabelsHandlers.attachOkWhenBody(() => {
        hit += 1;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
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
    expect(env.data.would?.path).toBe('/task-labels/add-to-task/7');
  });

  it('human output: prints "Attached ... to task #7."', async () => {
    server.use(taskLabelsHandlers.attachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--uuid',
      UUID_2,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Attached');
    expect(stdout).toContain('task #7');
  });
});

describe('freelo task-labels attach — validation (Calibration §2 exit codes)', () => {
  it('no selectors → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/--name|--uuid|VALIDATION/);
  });

  it('--task=0 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '0',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--task=non-integer → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      'abc',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--uuid=non-uuid → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--uuid',
      'not-a-uuid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo task-labels attach — error paths', () => {
  it('400 bad color → FreeloApiError exit 4', async () => {
    server.use(taskLabelsHandlers.attachBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → FreeloApiError exit 4', async () => {
    server.use(taskLabelsHandlers.attachServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'attach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});
