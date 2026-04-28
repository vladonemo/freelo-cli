/**
 * End-to-end tests for `freelo time status` (R19, spec 0030).
 *
 * Covers:
 *   - 200 active (with task / without task / no project / no tasklist).
 *   - 204 inactive: data.active=false, exit 0 (the load-bearing UX edge).
 *   - elapsed_seconds derivation (and clock-skew clamp at 0).
 *   - 401 (exit 3) — Calibration §2.
 *   - 5xx (exit 4) — Calibration §2.
 *   - Introspect entry (destructive: false).
 *   - `projectSession` pure-function tests for the wire→envelope projection.
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
  testDir = join(
    tmpdir(),
    `freelo-time-status-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths — 200 active
// ---------------------------------------------------------------------------

describe('freelo time status — 200 active', () => {
  it('with task + project + tasklist: full session shape', async () => {
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-1',
        date_reported: '2026-04-28T10:00:00Z',
        task: {
          id: 4567,
          name: 'Investigate bug',
          project: { id: 11, name: 'Web' },
          tasklist: { id: 22, name: 'Backend' },
        },
        note: 'wip',
        is_billable: true,
        is_cost_fixed: false,
        labels: [{ name: 'bug' }],
        cost: { amount: '100', currency: 'CZK' },
        project_setting: { foo: 'bar' },
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        active: boolean;
        session?: {
          uuid: string;
          started_at: string;
          elapsed_seconds: number;
          task: { id: number; name: string; project: { id: number; name: string } | null } | null;
          note: string | null;
          is_billable: boolean;
          labels: Array<{ name: string }>;
        };
      };
    };
    expect(env.schema).toBe('freelo.time.status/v1');
    expect(env.data.active).toBe(true);
    expect(env.data.session!.uuid).toBe('tt-uuid-1');
    expect(env.data.session!.started_at).toBe('2026-04-28T10:00:00Z');
    expect(typeof env.data.session!.elapsed_seconds).toBe('number');
    expect(env.data.session!.task!.id).toBe(4567);
    expect(env.data.session!.task!.project!.id).toBe(11);
    expect(env.data.session!.note).toBe('wip');
    expect(env.data.session!.is_billable).toBe(true);
    expect(env.data.session!.labels).toEqual([{ name: 'bug' }]);
  });

  it('without task (general work): session.task=null', async () => {
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-2',
        date_reported: '2026-04-28T10:00:00Z',
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { active: boolean; session?: { task: unknown; note: string | null } };
    };
    expect(env.data.active).toBe(true);
    expect(env.data.session!.task).toBe(null);
    expect(env.data.session!.note).toBe(null);
  });

  it('task without project/tasklist: project and tasklist null', async () => {
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-3',
        date_reported: '2026-04-28T10:00:00Z',
        task: { id: 4567, name: 'task', project: null, tasklist: null },
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        active: boolean;
        session?: { task: { id: number; project: unknown; tasklist: unknown } | null };
      };
    };
    expect(env.data.active).toBe(true);
    expect(env.data.session!.task!.project).toBe(null);
    expect(env.data.session!.task!.tasklist).toBe(null);
  });

  it('elapsed_seconds is computed from started_at', async () => {
    // 5 minutes ago.
    const startedAt = new Date(Date.now() - 5 * 60 * 1000).toISOString();
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-4',
        date_reported: startedAt,
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { session?: { elapsed_seconds: number } };
    };
    expect(env.data.session!.elapsed_seconds).toBeGreaterThanOrEqual(295);
    expect(env.data.session!.elapsed_seconds).toBeLessThanOrEqual(360);
  });

  it('clock skew (started_at in the future): elapsed_seconds clamps at 0', async () => {
    const futureStart = new Date(Date.now() + 60 * 1000).toISOString();
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-5',
        date_reported: futureStart,
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { session?: { elapsed_seconds: number } };
    };
    expect(env.data.session!.elapsed_seconds).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  204 inactive (the ship condition for status)
// ---------------------------------------------------------------------------

describe('freelo time status — 204 inactive (spec 0030 §2.5)', () => {
  it('204: data.active=false, exit 0', async () => {
    server.use(timeHandlers.statusInactive());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { active: boolean; session?: unknown };
    };
    expect(env.schema).toBe('freelo.time.status/v1');
    expect(env.data.active).toBe(false);
    expect('session' in env.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo time status — HTTP errors', () => {
  it('401: exit 3', async () => {
    server.use(timeHandlers.statusUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx: exit 4', async () => {
    server.use(timeHandlers.statusServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'status', '--output', 'json']);
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

describe('freelo time status — introspect', () => {
  it('appears in --introspect with destructive: false and the correct schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          output_schema: string;
          destructive: boolean;
        }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'time status');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.time.status/v1');
    expect(entry!.destructive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  projectSession unit tests (pure)
// ---------------------------------------------------------------------------

describe('projectSession — pure projection (spec 0030 §3.2)', () => {
  it('renames date_reported → started_at and computes elapsed_seconds', async () => {
    const { projectSession } = await import('../../../src/commands/time/status.js');
    const startedAt = '2026-04-28T10:00:00Z';
    const nowMs = Date.parse('2026-04-28T10:01:30Z');
    const out = projectSession(
      {
        uuid: 'u',
        date_reported: startedAt,
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      },
      nowMs,
    );
    expect(out.started_at).toBe(startedAt);
    expect(out.elapsed_seconds).toBe(90);
  });

  it('clamps negative elapsed (clock skew) at 0', async () => {
    const { projectSession } = await import('../../../src/commands/time/status.js');
    const startedAt = '2026-04-28T10:01:30Z';
    const nowMs = Date.parse('2026-04-28T10:00:00Z');
    const out = projectSession(
      {
        uuid: 'u',
        date_reported: startedAt,
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      },
      nowMs,
    );
    expect(out.elapsed_seconds).toBe(0);
  });

  it('handles malformed date_reported (NaN) → elapsed_seconds=0', async () => {
    const { projectSession } = await import('../../../src/commands/time/status.js');
    const out = projectSession(
      {
        uuid: 'u',
        date_reported: 'not-a-date',
        task: null,
        note: null,
        is_billable: false,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      },
      Date.now(),
    );
    expect(out.elapsed_seconds).toBe(0);
  });

  it('applies defaults for missing optional wire fields', async () => {
    const { projectSession } = await import('../../../src/commands/time/status.js');
    const out = projectSession(
      { uuid: 'u', date_reported: '2026-04-28T10:00:00Z' },
      Date.parse('2026-04-28T10:00:00Z'),
    );
    expect(out.task).toBe(null);
    expect(out.note).toBe(null);
    expect(out.is_billable).toBe(false);
    expect(out.is_cost_fixed).toBe(false);
    expect(out.labels).toEqual([]);
    expect(out.cost).toBe(null);
    expect(out.project_setting).toBe(null);
  });
});
