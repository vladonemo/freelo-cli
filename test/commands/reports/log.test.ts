/**
 * End-to-end tests for `freelo reports log` (R22, spec 0034).
 *
 * Covers:
 *   - Happy paths: single-mode minimal / full / dry-run / --stdin batch.
 *   - applied_input round-trip (decision: mirrors wire body).
 *   - --output round-trip via REPORT_RECENT fixture.
 *   - Validation (Calibration §2 — every typed-error path with explicit exitCode):
 *     missing --task, missing --minutes, --minutes 0 / negative / non-int,
 *     bad --date, single-mode flag set with --stdin (mutex).
 *   - HTTP errors: 401 (exit 3), 400 (exit 4), 5xx (exit 4), 429 (exit 6),
 *     network (exit 5).
 *   - Schema-validation: 200 with malformed body → FreeloApiError VALIDATION_ERROR exit 4.
 *   - Batch continue-on-error: bad row + good row → max-of exit code.
 *   - Introspect entry shows output_schema and destructive: false.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, workReportsWriteHandlers } from '../../msw/handlers.js';

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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stream,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: original,
    });
  };
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
    `freelo-reports-log-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const REPORT_FIXTURE = {
  id: 7001,
  date_add: '2026-04-25T10:00:00Z',
  date_reported: '2026-04-25',
  note: 'WIP',
  minutes: 90,
  cost: { amount: '1500', currency: 'CZK' },
  author: { id: 7, fullname: 'Alice' },
  worker: { id: 7, fullname: 'Alice' },
  task: { id: 4567, name: 'Wire up the dashboard' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo reports log — happy paths', () => {
  it('minimal: --task + --minutes; envelope shape + applied_input', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.createOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '90',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 90 });
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { applied_input: Record<string, unknown>; report: { id: number } };
    };
    expect(env.schema).toBe('freelo.reports.log/v1');
    expect(env.data.applied_input).toEqual({ task_id: 4567, minutes: 90 });
    expect(env.data.report.id).toBe(7001);
  });

  it('full: --task + --minutes + --date + --note; wire body has all four; date_reported sent', async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedPath: string | undefined;
    server.use(
      workReportsWriteHandlers.createOkWhenBody((body, request) => {
        capturedBody = body as Record<string, unknown>;
        capturedPath = new URL(request.url).pathname;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stdout } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '90',
      '--date',
      '2026-04-25',
      '--note',
      'WIP',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({ minutes: 90, date_reported: '2026-04-25', note: 'WIP' });
    expect(capturedPath).toContain('/task/4567/work-reports');
    const env = parseFirstJson(stdout) as {
      data: { applied_input: Record<string, unknown> };
    };
    expect(env.data.applied_input).toEqual({
      task_id: 4567,
      minutes: 90,
      date_reported: '2026-04-25',
      note: 'WIP',
    });
  });

  it('--dry-run: no POST, would.body matches', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '90',
      '--note',
      'WIP',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        applied_input: Record<string, unknown>;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/4567/work-reports');
    expect(env.data.would.body).toEqual({ minutes: 90, note: 'WIP' });
  });

  it('--note "" (empty string): wire body sends note: "" (not omitted)', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.createOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '90',
      '--note',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 90, note: '' });
  });

  it('--stdin batch: two rows; both succeed; line_index attached', async () => {
    server.use(workReportsWriteHandlers.createOk(REPORT_FIXTURE));
    const ndjson = '{"task":4567,"minutes":30}\n{"task":4567,"minutes":60,"note":"second"}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'log',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout) as Array<{
        data: { line_index: number; applied_input: Record<string, unknown> };
      }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.data.line_index).toBe(0);
      expect(lines[1]!.data.line_index).toBe(1);
      expect(lines[0]!.data.applied_input).toEqual({ task_id: 4567, minutes: 30 });
      expect(lines[1]!.data.applied_input).toEqual({ task_id: 4567, minutes: 60, note: 'second' });
    } finally {
      restore();
    }
  });

  it('--stdin --dry-run: emits dry_run envelopes per row, no POST', async () => {
    const ndjson = '{"task":1,"minutes":10}\n{"task":2,"minutes":20}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'log',
        '--stdin',
        '--dry-run',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout) as Array<{ dry_run: boolean }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.dry_run).toBe(true);
      expect(lines[1]!.dry_run).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo reports log — validation', () => {
  it('missing --task: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('missing --minutes: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--minutes 0: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--minutes negative: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '-5',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--date 2026/04/25: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--date',
      '2026/04/25',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--date 2026-13-99 (invalid calendar): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--date',
      '2026-13-99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--task with --stdin (mutex): VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('{"task":1,"minutes":10}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'reports',
        'log',
        '--task',
        '4567',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('VALIDATION_ERROR');
      expect(stderr).toContain('mutex');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo reports log — HTTP errors', () => {
  it('POST 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(workReportsWriteHandlers.createUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('POST 400 (WorkReportCanNotBeCreatedException): FREELO_API_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.createBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
  });

  it('POST 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.createServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('POST 429 (after retry exhaustion): RATE_LIMITED, exit 6', async () => {
    server.use(workReportsWriteHandlers.createRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('POST network failure: NETWORK_ERROR, exit 5', async () => {
    server.use(workReportsWriteHandlers.createNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });

  it('POST 200 with malformed body: VALIDATION_ERROR (FreeloApiError), exit 4', async () => {
    server.use(workReportsWriteHandlers.createMalformed());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'log',
      '--task',
      '4567',
      '--minutes',
      '30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Batch — continue-on-error
// ---------------------------------------------------------------------------

describe('freelo reports log — batch continue-on-error', () => {
  it('one bad NDJSON row + one good row: per-line error envelope + max-of exit code 2', async () => {
    server.use(workReportsWriteHandlers.createOk(REPORT_FIXTURE));
    const ndjson = 'not-json\n{"task":4567,"minutes":30}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'log',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout) as Array<{ schema: string }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.schema).toBe('freelo.error/v1');
      expect(lines[1]!.schema).toBe('freelo.reports.log/v1');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo reports log — introspect', () => {
  it('lists reports log with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'reports log');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.reports.log/v1');
    expect(entry?.destructive).toBe(false);
  });
});
