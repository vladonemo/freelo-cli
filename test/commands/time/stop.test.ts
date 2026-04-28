/**
 * End-to-end tests for `freelo time stop` (R20, spec 0032).
 *
 * Covers:
 *   - Happy paths: with task, with general work (`task: null`), `--dry-run`.
 *   - No-active-session 409 → friendly hint pointing at `freelo time start`
 *     (the load-bearing UX edge — spec 0032 §2.4).
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4) — Calibration §2.
 *   - Wire body is empty (POST with no body, per OpenAPI yaml :2793).
 *   - Introspect entry (destructive: false, schema correct).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, timeHandlers } from '../../msw/handlers.js';

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
  testDir = join(tmpdir(), `freelo-time-stop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

const SAMPLE_WORK_REPORT = {
  id: 987,
  date_add: '2026-04-28T15:30:00Z',
  date_reported: '2026-04-28',
  minutes: 42,
  note: 'WIP',
  cost: { amount: '0', currency: 'CZK' },
  author: { id: 1, fullname: 'agent' },
  worker: { id: 1, fullname: 'agent' },
  task: { id: 4567, name: 'Investigate bug' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo time stop — happy paths', () => {
  it('with task: exit 0, schema, work_report fields populated', async () => {
    server.use(timeHandlers.stopOk(SAMPLE_WORK_REPORT));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'stop', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        work_report: {
          id: number;
          minutes: number;
          task: { id: number; name: string } | null;
          cost: { amount: string; currency: string } | null;
          note: string | null;
        };
      };
    };
    expect(env.schema).toBe('freelo.time.stop/v1');
    expect(env.data.work_report.id).toBe(987);
    expect(env.data.work_report.minutes).toBe(42);
    expect(env.data.work_report.task).toEqual({ id: 4567, name: 'Investigate bug' });
    expect(env.data.work_report.cost).toEqual({ amount: '0', currency: 'CZK' });
    expect(env.data.work_report.note).toBe('WIP');
  });

  it('general work (task: null): envelope task is null', async () => {
    server.use(
      timeHandlers.stopOk({
        id: 988,
        date_add: '2026-04-28T15:31:00Z',
        date_reported: '2026-04-28',
        minutes: 7,
        note: null,
        cost: null,
        author: { id: 1, fullname: 'agent' },
        worker: { id: 1, fullname: 'agent' },
        task: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'stop', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { work_report: { task: unknown; cost: unknown; note: string | null } };
    };
    expect(env.data.work_report.task).toBeNull();
    expect(env.data.work_report.cost).toBeNull();
    expect(env.data.work_report.note).toBeNull();
  });

  it('--dry-run: no POST, dry_run=true, would carries null body', async () => {
    // No handler registered — onUnhandledRequest:'error' would trip on a POST.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'stop',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run?: boolean;
      data: {
        would: { method: string; path: string; body: unknown };
        work_report?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.time.stop/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/timetracking/stop');
    expect(env.data.would.body).toBeNull();
    // Live-only field absent in dry-run.
    expect('work_report' in env.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  No-active-session 409 hint rewriter (the ship condition)
// ---------------------------------------------------------------------------

describe('freelo time stop — no-active-session 409 hint (spec 0032 §2.4)', () => {
  it('409: exit 4, hint mentions `freelo time start` and "no active"', async () => {
    server.use(timeHandlers.stopConflict());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'stop', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { http_status: number; hint_next: string; code: string; retryable: boolean };
    };
    expect(env.error.http_status).toBe(409);
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.retryable).toBe(false);
    expect(env.error.hint_next).toContain('No active');
    expect(env.error.hint_next).toContain('freelo time start');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo time stop — HTTP errors', () => {
  it('401: exit 3 (auth)', async () => {
    server.use(timeHandlers.stopUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'stop', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx: exit 4 (retryable)', async () => {
    server.use(timeHandlers.stopServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'stop', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { http_status: number; retryable: boolean };
    };
    expect(env.error.http_status).toBe(503);
    expect(env.error.retryable).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Introspect entry
// ---------------------------------------------------------------------------

describe('freelo time stop — introspect', () => {
  it('appears in --introspect with destructive: false and the correct schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'time stop');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.time.stop/v1');
    expect(entry!.destructive).toBe(false);
  });
});
