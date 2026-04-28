/**
 * End-to-end tests for `freelo time edit` (R20, spec 0032).
 *
 * Covers:
 *   - Happy paths: --task only, --clear-task only, --note only, --task+--note,
 *     --clear-task+--note, --note "" (empty allowed).
 *   - Validation (Calibration §2 — every error class has an explicit exitCode):
 *     - empty edit (no flags) → ValidationError exit 2
 *     - --task + --clear-task mutex → ValidationError exit 2
 *     - --task non-numeric / zero / negative → ValidationError exit 2
 *   - --dry-run: no POST, would.body matches.
 *   - applied_changes mirrors the wire body shape (decision 6).
 *   - No-active-session 409 → friendly hint pointing at `freelo time start`.
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4).
 *   - Introspect entry.
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
  testDir = join(tmpdir(), `freelo-time-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo time edit — happy paths', () => {
  it('--task only: wire body { task_id }, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-task'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--task',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_id: 4567 });
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { uuid: string; applied_changes: Record<string, unknown> };
    };
    expect(env.schema).toBe('freelo.time.edit/v1');
    expect(env.data.uuid).toBe('tt-uuid-edit-task');
    expect(env.data.applied_changes).toEqual({ task_id: 4567 });
  });

  it('--clear-task only: wire body { task_id: null }, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-notask'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--clear-task',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_id: null });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ task_id: null });
  });

  it('--note only: wire body { note }, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-note'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--note',
      'updated',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ note: 'updated' });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ note: 'updated' });
  });

  it('--task + --note: wire body has both, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-both'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--task',
      '4568',
      '--note',
      'switched context',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_id: 4568, note: 'switched context' });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ task_id: 4568, note: 'switched context' });
  });

  it('--clear-task + --note: wire body has both, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-notaskmore'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--clear-task',
      '--note',
      'general',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ task_id: null, note: 'general' });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ task_id: null, note: 'general' });
  });

  it('--note "": empty string allowed (server accepts)', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      timeHandlers.editTimerOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, 'tt-uuid-edit-empty'),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'edit', '--note', '', '--output', 'json']);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ note: '' });
  });

  it('--dry-run: no POST, dry_run=true, would.body matches', async () => {
    // No handler registered — onUnhandledRequest:'error' would trip on a POST.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
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
        applied_changes: Record<string, unknown>;
        uuid?: string;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.time.edit/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/timetracking/edit');
    expect(env.data.would.body).toEqual({ task_id: 4567, note: 'dry' });
    expect(env.data.applied_changes).toEqual({ task_id: 4567, note: 'dry' });
    // Live-only field absent in dry-run.
    expect('uuid' in env.data).toBe(false);
  });

  it('--clear-task + --dry-run: would.body has task_id: null', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--clear-task',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({ task_id: null });
  });
});

// ---------------------------------------------------------------------------
//  Validation (Calibration §2 — exit 2 on bad input)
// ---------------------------------------------------------------------------

describe('freelo time edit — validation', () => {
  it('empty edit (no flags): exit 2 (ValidationError)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['time', 'edit', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      schema: string;
      error: { code: string; message: string; hint_next: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('at least one');
  });

  it('--task + --clear-task mutex: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--task',
      '4567',
      '--clear-task',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { code: string; message: string };
    };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('mutually exclusive');
  });

  it('non-numeric --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'edit', '--task', 'abc', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('zero --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'edit', '--task', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('negative --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'edit', '--task', '-3', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  No-active-session 409 hint rewriter
// ---------------------------------------------------------------------------

describe('freelo time edit — no-active-session 409 hint (spec 0032 §2.4)', () => {
  it('409: exit 4, hint mentions `freelo time start` and "no active"', async () => {
    server.use(timeHandlers.editTimerConflict());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--note',
      'x',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = JSON.parse(stderr.split('\n').find((l) => l.startsWith('{')) ?? '{}') as {
      error: { http_status: number; hint_next: string; code: string };
    };
    expect(env.error.http_status).toBe(409);
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.hint_next).toContain('No active');
    expect(env.error.hint_next).toContain('freelo time start');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo time edit — HTTP errors', () => {
  it('401: exit 3 (auth)', async () => {
    server.use(timeHandlers.editTimerUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['time', 'edit', '--note', 'x', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx: exit 4 (retryable)', async () => {
    server.use(timeHandlers.editTimerServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'time',
      'edit',
      '--note',
      'x',
      '--output',
      'json',
    ]);
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

describe('freelo time edit — introspect', () => {
  it('appears in --introspect with destructive: false and the correct schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'time edit');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.time.edit/v1');
    expect(entry!.destructive).toBe(false);
  });
});
