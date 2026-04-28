/**
 * End-to-end tests for `freelo time start` (R19, spec 0030).
 *
 * Covers:
 *   - Happy paths: bare invocation, --task only, --note only, both flags,
 *     --dry-run.
 *   - Singleton 409: hint enrichment when status follow-up succeeds; fallback
 *     when follow-up fails (spec 0030 §2.4 — the ship condition).
 *   - --task validation (non-numeric, zero, negative).
 *   - HTTP errors: 401 (exit 3), 404 task-not-found (exit 4), 5xx (exit 4)
 *     (Calibration §2 — every typed-error class asserted by exitCode).
 *   - Wire body capture.
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
  testDir = join(
    tmpdir(),
    `freelo-time-start-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo time start — happy paths', () => {
  it('bare invocation: exit 0, schema, task_id=null, note=null', async () => {
    server.use(timeHandlers.startOk('tt-uuid-bare'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { uuid: string; task_id: number | null; note: string | null };
    };
    expect(env.schema).toBe('freelo.time.start/v1');
    expect(env.data.uuid).toBe('tt-uuid-bare');
    expect(env.data.task_id).toBe(null);
    expect(env.data.note).toBe(null);
  });

  it('--task only: task_id echoed, note=null', async () => {
    server.use(timeHandlers.startOk('tt-uuid-task'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'start',
      '--task',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { task_id: number | null; note: string | null } };
    expect(env.data.task_id).toBe(4567);
    expect(env.data.note).toBe(null);
  });

  it('--note only: note echoed, task_id=null', async () => {
    server.use(timeHandlers.startOk('tt-uuid-note'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'start',
      '--note',
      'general work',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { task_id: number | null; note: string | null } };
    expect(env.data.task_id).toBe(null);
    expect(env.data.note).toBe('general work');
  });

  it('--task and --note: both echoed', async () => {
    server.use(timeHandlers.startOk('tt-uuid-both'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'start',
      '--task',
      '4567',
      '--note',
      'WIP',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { task_id: number | null; note: string | null } };
    expect(env.data.task_id).toBe(4567);
    expect(env.data.note).toBe('WIP');
  });

  it('wire body: { task_id, note } sent on the wire', async () => {
    let captured: unknown;
    server.use(
      timeHandlers.startOkWhenBody((body) => {
        captured = body;
        return true;
      }, 'tt-uuid-wire'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'time',
      'start',
      '--task',
      '99',
      '--note',
      'msg',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_id: 99, note: 'msg' });
  });

  it('--dry-run: no POST, dry_run=true, would echoes path+body', async () => {
    // No handler registered — onUnhandledRequest:'error' would trip if a POST happens.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'start',
      '--task',
      '4567',
      '--note',
      'dry',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run?: boolean;
      data: {
        task_id: number | null;
        note: string | null;
        uuid?: string;
        would: { method: string; path: string; body: { task_id?: number; note?: string } };
      };
    };
    expect(env.schema).toBe('freelo.time.start/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    expect(env.data.note).toBe('dry');
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/timetracking/start');
    expect(env.data.would.body).toEqual({ task_id: 4567, note: 'dry' });
    // Live-only field absent in dry-run.
    expect('uuid' in env.data).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  Singleton-409 hint rewriter (the ship condition)
// ---------------------------------------------------------------------------

describe('freelo time start — singleton 409 hint (spec 0030 §2.4)', () => {
  it('409 + status follow-up succeeds: hint mentions task and started_at', async () => {
    server.use(timeHandlers.startConflict());
    server.use(
      timeHandlers.statusActive({
        uuid: 'tt-uuid-active',
        date_reported: '2026-04-28T10:00:00Z',
        task: { id: 4567, name: 'Investigate bug', project: null, tasklist: null },
        note: 'wip',
        is_billable: true,
        is_cost_fixed: false,
        labels: [],
        cost: {},
        project_setting: null,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { http_status: number; hint_next: string; code: string; retryable: boolean };
    };
    expect(env.error.http_status).toBe(409);
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.retryable).toBe(false);
    // Hint enrichment.
    expect(env.error.hint_next).toContain('2026-04-28T10:00:00Z');
    expect(env.error.hint_next).toContain('task #4567');
    expect(env.error.hint_next).toContain('Investigate bug');
    expect(env.error.hint_next).toContain('time stop');
    expect(env.error.hint_next).toContain('time edit');
  });

  it('409 + status follow-up fails (5xx): falls back to generic hint', async () => {
    server.use(timeHandlers.startConflict());
    server.use(timeHandlers.statusServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { http_status: number; hint_next: string };
    };
    expect(env.error.http_status).toBe(409);
    // Generic copy — does NOT mention a specific task/start time.
    expect(env.error.hint_next).toContain('time stop');
    expect(env.error.hint_next).toContain('time edit');
    expect(env.error.hint_next).not.toContain('task #');
  });

  it('409 + status follow-up returns 204 (unexpected): falls back to generic hint', async () => {
    server.use(timeHandlers.startConflict());
    server.use(timeHandlers.statusInactive());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { hint_next: string };
    };
    // Hint says "already running" but cannot enrich because the status was null.
    expect(env.error.hint_next).toContain('already running');
    expect(env.error.hint_next).not.toContain('task #');
  });
});

// ---------------------------------------------------------------------------
//  --task validation (Calibration §2 — exit 2 on bad input)
// ---------------------------------------------------------------------------

describe('freelo time start — --task validation', () => {
  it('non-numeric --task: exit 2 (ValidationError)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'start', '--task', 'abc', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('zero --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'start', '--task', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('negative --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'start', '--task', '-3', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo time start — HTTP errors', () => {
  it('401: exit 3 (auth)', async () => {
    server.use(timeHandlers.startUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('404 with --task: exit 4, hint mentions the task id', async () => {
    server.use(timeHandlers.startNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'time',
      'start',
      '--task',
      '777',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { hint_next: string };
    };
    expect(env.error.hint_next).toContain('777');
  });

  it('5xx: exit 4 (FREELO_API_ERROR retryable)', async () => {
    server.use(timeHandlers.startServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'start', '--output', 'json']);
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

describe('freelo time start — introspect', () => {
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
    const entry = env.data.commands.find((c) => c.name === 'time start');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.time.start/v1');
    expect(entry!.destructive).toBe(false);
  });
});
