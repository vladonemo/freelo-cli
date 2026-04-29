/**
 * End-to-end tests for `freelo reports edit` (R22, spec 0034).
 *
 * Covers:
 *   - Happy paths: --minutes only, --note only, --date only, all three.
 *   - applied_changes mirrors the wire body (decision: spec §5.2).
 *   - --dry-run: no POST, would.body matches.
 *   - --note "" (empty string allowed).
 *   - --stdin batch with rich rows.
 *   - Validation (Calibration §2): empty edit, bad <id>, bad --minutes,
 *     bad --date, mutex with --stdin, per-row empty-edit in batch.
 *   - HTTP errors: 401 (exit 3), 404 (NotFoundException; exit 4), 5xx (exit 4).
 *   - Introspect entry.
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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  return () => {
    Object.defineProperty(process, 'stdin', { configurable: true, value: original });
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
    `freelo-reports-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  note: 'Updated',
  minutes: 60,
  cost: { amount: '1000', currency: 'CZK' },
  author: { id: 7, fullname: 'Alice' },
  worker: { id: 7, fullname: 'Alice' },
  task: { id: 4567, name: 'Wire up the dashboard' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo reports edit — happy paths', () => {
  it('--minutes only: wire body { minutes }, applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    let path: string | undefined;
    server.use(
      workReportsWriteHandlers.editOkWhenBody((body, request) => {
        captured = body as Record<string, unknown>;
        path = new URL(request.url).pathname;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 60 });
    expect(path).toContain('/work-reports/7001');
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { applied_changes: Record<string, unknown>; report: { id: number } };
    };
    expect(env.schema).toBe('freelo.reports.edit/v1');
    expect(env.data.applied_changes).toEqual({ minutes: 60 });
    expect(env.data.report.id).toBe(7001);
  });

  it('--note only: wire body { note }', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.editOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--note',
      'updated',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ note: 'updated' });
  });

  it('--date only: wire body { date_reported }', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.editOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--date',
      '2026-04-30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ date_reported: '2026-04-30' });
  });

  it('all three flags: body has all three; applied_changes mirrors', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.editOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--note',
      'updated',
      '--date',
      '2026-04-30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ minutes: 60, note: 'updated', date_reported: '2026-04-30' });
    const env = parseFirstJson(stdout) as { data: { applied_changes: Record<string, unknown> } };
    expect(env.data.applied_changes).toEqual({
      minutes: 60,
      note: 'updated',
      date_reported: '2026-04-30',
    });
  });

  it('--note "" (empty string): wire body sends note: ""', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      workReportsWriteHandlers.editOkWhenBody((body) => {
        captured = body as Record<string, unknown>;
        return true;
      }, REPORT_FIXTURE),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--note',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ note: '' });
  });

  it('--dry-run: no POST, would.body matches', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { would: { method: string; path: string; body: Record<string, unknown> } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/work-reports/7001');
    expect(env.data.would.body).toEqual({ minutes: 60 });
  });

  it('--stdin batch: two rows succeed; line_index attached', async () => {
    server.use(workReportsWriteHandlers.editOk(REPORT_FIXTURE));
    const ndjson = '{"id":7001,"minutes":60}\n{"id":7002,"note":"x"}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'edit',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout) as Array<{
        data: { line_index: number; applied_changes: Record<string, unknown> };
      }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.data.line_index).toBe(0);
      expect(lines[1]!.data.line_index).toBe(1);
      expect(lines[0]!.data.applied_changes).toEqual({ minutes: 60 });
      expect(lines[1]!.data.applied_changes).toEqual({ note: 'x' });
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo reports edit — validation', () => {
  it('empty edit (no flags): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['reports', 'edit', '7001', '--output', 'json']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('at least one');
  });

  it('missing <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '--minutes',
      '60',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('<id> 0: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '0',
      '--minutes',
      '60',
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
      'edit',
      '7001',
      '--minutes',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--date bad-format: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--date',
      '2026/04/25',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('positional + --stdin (mutex): VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin('{"id":1,"minutes":10}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'reports',
        'edit',
        '7001',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });

  it('--stdin: empty per-row edit emits per-line error, exit 2', async () => {
    server.use(workReportsWriteHandlers.editOk(REPORT_FIXTURE));
    const ndjson = '{"id":7001}\n{"id":7002,"minutes":60}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'edit',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout) as Array<{ schema: string }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.schema).toBe('freelo.error/v1');
      expect(lines[1]!.schema).toBe('freelo.reports.edit/v1');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo reports edit — HTTP errors', () => {
  it('POST 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(workReportsWriteHandlers.editUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('POST 404 (NotFoundException — ACL or genuine missing): NOT_FOUND, exit 4', async () => {
    server.use(workReportsWriteHandlers.editNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
  });

  it('POST 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.editServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'edit',
      '7001',
      '--minutes',
      '60',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo reports edit — introspect', () => {
  it('lists reports edit with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'reports edit');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.reports.edit/v1');
    expect(entry?.destructive).toBe(false);
  });
});
