/**
 * End-to-end tests for `freelo task-labels detach` (R24, spec 0036).
 *
 * Verb is POST per OpenAPI (decision 01), not DELETE.
 * Server is already idempotent — no 404 heuristic needed.
 *
 * Covers:
 *   - Happy paths: name-only mode, name+color, uuid-mode, mixed, multiple names
 *   - Validation (Calibration §2 exit codes asserted on each typed error)
 *   - HTTP error: 5xx → exit 4
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';

const UUID = '11111111-1111-1111-1111-111111111111';

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
    `freelo-task-labels-detach-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo task-labels detach — happy paths', () => {
  it('--name only: name-only mode entry (no color)', async () => {
    server.use(
      taskLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        if (!Array.isArray(b.labels) || b.labels.length !== 1) return false;
        const entry = b.labels[0]!;
        return entry['name'] === 'Bug' && !('color' in entry) && !('uuid' in entry);
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { schema: string; data: { task_id: number } };
    expect(env.schema).toBe('freelo.task_labels.detach/v1');
    expect(env.data.task_id).toBe(7);
  });

  it('--name + --hex: upgrades to name+color mode', async () => {
    server.use(
      taskLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return b.labels?.[0]?.['name'] === 'Bug' && b.labels?.[0]?.['color'] === '#abcdef';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
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

  it('--uuid: uuid-mode entry', async () => {
    server.use(
      taskLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return (
          b.labels?.[0]?.['uuid'] === UUID &&
          !('name' in (b.labels?.[0] ?? {})) &&
          !('color' in (b.labels?.[0] ?? {}))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--uuid',
      UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('mixed --name + --uuid: 2 entries', async () => {
    server.use(
      taskLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return Array.isArray(b.labels) && b.labels.length === 2;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
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

  it('multiple --name: 2 name-mode entries', async () => {
    server.use(
      taskLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as { labels?: Array<Record<string, unknown>> };
        return (
          Array.isArray(b.labels) &&
          b.labels.length === 2 &&
          b.labels[0]?.['name'] === 'Bug' &&
          b.labels[1]?.['name'] === 'Wip'
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--name',
      'Wip',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('--dry-run: no fetch; would.path includes task id', async () => {
    let hit = 0;
    server.use(
      taskLabelsHandlers.detachOkWhenBody(() => {
        hit += 1;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '42',
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
    expect(env.data.would?.path).toBe('/task-labels/remove-from-task/42');
  });

  it('human output: prints "Detached ... from task #7."', async () => {
    server.use(taskLabelsHandlers.detachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Detached');
    expect(stdout).toContain('task #7');
  });
});

describe('freelo task-labels detach — validation (Calibration §2 exit codes)', () => {
  it('no selectors → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'detach',
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
      'detach',
      '--task',
      '0',
      '--name',
      'Bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--uuid=bad-shape → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--uuid',
      'bad-uuid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --hex → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
      '--task',
      '7',
      '--name',
      'Bug',
      '--hex',
      '#xyz',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo task-labels detach — error paths', () => {
  it('5xx → FreeloApiError exit 4', async () => {
    server.use(taskLabelsHandlers.detachServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'detach',
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
