/**
 * End-to-end tests for `freelo reports delete` (R22, spec 0034).
 *
 * The second destructive command in the CLI (after `tasks delete`).
 *
 * Covers:
 *   - Happy paths: single positional --yes, multi positional, --ids, --stdin.
 *   - --dry-run skips both confirmation and the wire call.
 *   - **Four-arm idempotency matrix (decision 02):**
 *       1. 404                                        → already_in_target_state: true, exit 0
 *       2. 400 + body matches /not found|does not exist/i → idempotent skip, exit 0
 *       3. 400 + UserCannotDeleteWorkReport ACL marker → hard FREELO_API_ERROR, exit 4
 *       4. Other non-2xx                              → hard error
 *     Each arm has its own dedicated test (Calibration §4).
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad ids, mutex inputs, missing source.
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4), 429 (exit 6).
 *   - Introspect entry shows destructive: true.
 *   - Direct unit test for `isIdempotentDeleteSkip` matrix.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts it.
 * Calibration §2: each typed error class has a triggering test.
 * Calibration §4: each new try/catch arm (the four idempotency arms, the
 * batch per-id catch) has a dedicated row.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, workReportsWriteHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/reports/delete.js';
import { FreeloApiError } from '../../../src/errors/freelo-api-error.js';

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
    `freelo-reports-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo reports delete — happy paths', () => {
  it('single positional with --yes: success envelope, exit 0', async () => {
    server.use(workReportsWriteHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        report_id: number;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.reports.delete/v1');
    expect(env.data.report_id).toBe(7001);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi positional with --yes: per-id envelopes', async () => {
    server.use(workReportsWriteHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '7002',
      '7003',
      '--yes',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
  });

  it('--ids flag with --yes: parses comma list', async () => {
    server.use(workReportsWriteHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '--ids',
      '7001,7002',
      '--yes',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('--stdin batch with --yes: per-line envelopes with line_index', async () => {
    server.use(workReportsWriteHandlers.deleteOk());
    const ndjson = '{"id":7001}\n{"id":7002}\n';
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'reports',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout) as Array<{ data: { line_index: number } }>;
      expect(lines).toHaveLength(2);
      expect(lines[0]!.data.line_index).toBe(0);
      expect(lines[1]!.data.line_index).toBe(1);
    } finally {
      restore();
    }
  });

  it('--dry-run: no DELETE, no confirmation needed, would.path stamped', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { would: { method: string; path: string }; report_id: number };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe('/work-reports/7001');
    expect(env.data.report_id).toBe(7001);
  });
});

// ---------------------------------------------------------------------------
//  Idempotency four-arm matrix (Calibration §4 — each arm dedicated test)
// ---------------------------------------------------------------------------

describe('freelo reports delete — idempotency four-arm matrix', () => {
  it('arm 1: 404 → already_in_target_state: true, exit 0', async () => {
    server.use(workReportsWriteHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '99999',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; current_state: string };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.current_state).toBe('deleted');
  });

  it('arm 2: 400 with "does not exist" body → idempotent skip, exit 0', async () => {
    server.use(workReportsWriteHandlers.deleteBadRequestNotFound('Work report does not exist.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 2: 400 with "not found" body → idempotent skip, exit 0', async () => {
    server.use(workReportsWriteHandlers.deleteBadRequestNotFound('Report not found.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 3: 400 with UserCannotDeleteWorkReport → hard FREELO_API_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.deleteBadRequestAcl());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
  });

  it('arm 4: 400 without either marker → hard FREELO_API_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.deleteBadRequestOther());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo reports delete — confirmation policy', () => {
  it('non-TTY without --yes (no --dry-run): CONFIRMATION_REQUIRED exit 2, no wire call', async () => {
    let wireCalled = false;
    server.use(
      // If a DELETE somehow fires, we want it loud.
      workReportsWriteHandlers.perIdRouter({
        '7001': () => {
          wireCalled = true;
          return new Response(JSON.stringify({ result: 'success' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('CONFIRMATION_REQUIRED');
    expect(wireCalled).toBe(false);
  });

  it('--dry-run without --yes: bypasses confirmation; exit 0', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo reports delete — validation', () => {
  it('positional + --ids (mutex): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--ids',
      '7002',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('no source: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('<id> non-positive (0): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--ids with no parseable tokens: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '--ids',
      '   ,  ',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors
// ---------------------------------------------------------------------------

describe('freelo reports delete — HTTP errors', () => {
  it('DELETE 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(workReportsWriteHandlers.deleteUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('DELETE 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(workReportsWriteHandlers.deleteServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('DELETE 429: RATE_LIMITED, exit 6', async () => {
    server.use(workReportsWriteHandlers.deleteRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });
});

// ---------------------------------------------------------------------------
//  Batch — mixed success and idempotent skip
// ---------------------------------------------------------------------------

describe('freelo reports delete — batch with idempotent skip', () => {
  it('two ids, second is 404 → both succeed, second has already_in_target_state: true', async () => {
    server.use(
      workReportsWriteHandlers.perIdRouter({
        '7001': () =>
          new Response(JSON.stringify({ result: 'success' }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        '99999': () =>
          new Response(JSON.stringify({ errors: ['Not found.'] }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'reports',
      'delete',
      '7001',
      '99999',
      '--yes',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout) as Array<{
      data: { report_id: number; already_in_target_state: boolean };
    }>;
    expect(lines).toHaveLength(2);
    expect(lines[0]!.data.report_id).toBe(7001);
    expect(lines[0]!.data.already_in_target_state).toBe(false);
    expect(lines[1]!.data.report_id).toBe(99999);
    expect(lines[1]!.data.already_in_target_state).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo reports delete — introspect', () => {
  it('lists reports delete with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'reports delete');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.reports.delete/v1');
    expect(entry?.destructive).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Unit test of `isIdempotentDeleteSkip` matrix (direct, no harness)
//
//  Calibration §4: the heuristic itself has dedicated coverage independent
//  of the end-to-end run — so a future refactor can't silently break a
//  branch.
// ---------------------------------------------------------------------------

describe('isIdempotentDeleteSkip — heuristic matrix', () => {
  it('arm 1: 404 returns true', () => {
    const err = new FreeloApiError('Not found', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('arm 2: 400 with "not found" in errors[] returns true', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', {
      httpStatus: 400,
      errors: ['Report not found.'],
    });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('arm 2: 400 with "does not exist" in errors[] returns true', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', {
      httpStatus: 400,
      errors: ['Work report does not exist.'],
    });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('arm 3: 400 with UserCannotDeleteWorkReport returns false (hard error)', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', {
      httpStatus: 400,
      errors: ['UserCannotDeleteWorkReport: caller is not the report author.'],
    });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 3 short-circuits arm 2: ACL marker AND "not found" text → false', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', {
      httpStatus: 400,
      errors: ['UserCannotDeleteWorkReport (does not exist anyway)'],
    });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 4: 400 with neither marker returns false', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', {
      httpStatus: 400,
      errors: ['Some other validation error.'],
    });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 4: 500 returns false', () => {
    const err = new FreeloApiError('Server error', 'SERVER_ERROR', { httpStatus: 500 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 4: 403 returns false', () => {
    const err = new FreeloApiError('Forbidden', 'FORBIDDEN', { httpStatus: 403 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });
});
