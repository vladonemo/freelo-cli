/**
 * End-to-end tests for `freelo custom-fields delete` (R41, spec 0055).
 *
 * Covers:
 *   - Happy paths: single positional --yes, multi positional, --ids, --stdin.
 *   - --dry-run skips both confirmation and the wire call.
 *   - **Single-arm idempotency (decision 3):** 404 → already_in_target_state: true,
 *     exit 0. Other non-2xx → re-throw.
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad uuid (positional / --ids / NDJSON line), mutex inputs.
 *   - HTTP errors with exit codes (Calibration §2):
 *     401 → exit 3, 403 → exit 4, 5xx → exit 4, 429 → exit 6.
 *   - Introspect entry shows destructive: true.
 *   - Direct unit test for `isIdempotentDeleteSkip` matrix.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsCrudHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/custom-fields/delete.js';
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

const UUID_A = '11111111-1111-1111-1111-111111111111';
const UUID_B = '22222222-2222-2222-2222-222222222222';
const UUID_C = '33333333-3333-3333-3333-333333333333';

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-cf-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo custom-fields delete — happy paths', () => {
  it('single positional with --yes: success envelope, exit 0', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { uuid: string; current_state: string; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.custom-fields.delete/v1');
    expect(env.data.uuid).toBe(UUID_A);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi positional: per-uuid envelopes', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { data: { uuid: string } }).data.uuid).toBe(UUID_A);
    expect((lines[1] as { data: { uuid: string } }).data.uuid).toBe(UUID_B);
  });

  it('--ids comma-separated', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      '--ids',
      `${UUID_A},${UUID_B}`,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(parseAllJsonLines(stdout)).toHaveLength(2);
  });

  it('--stdin NDJSON', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"${UUID_B}"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { data: { line_index: number } }).data.line_index).toBe(0);
      expect((lines[1] as { data: { line_index: number } }).data.line_index).toBe(1);
    } finally {
      restore();
    }
  });

  it('empty --stdin → silent success, exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('--dry-run: no wire call, no confirmation, envelope echoes would', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: true;
      data: { uuid: string; would: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe(`/custom-field/delete/${UUID_A}`);
  });
});

describe('freelo custom-fields delete — idempotency (single-arm 404)', () => {
  it('404 → already_in_target_state: true, exit 0', async () => {
    server.use(customFieldsCrudHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
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

  it('mixed 200 + 404 across multi-positional: both succeed, exit 0', async () => {
    server.use(
      customFieldsCrudHandlers.deletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Not found.'] }), { status: 404 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout) as Array<{
      data: { uuid: string; already_in_target_state: boolean };
    }>;
    expect(lines[0]!.data.already_in_target_state).toBe(false);
    expect(lines[1]!.data.already_in_target_state).toBe(true);
  });
});

describe('freelo custom-fields delete — confirmation policy', () => {
  it('non-TTY without --yes → CONFIRMATION_REQUIRED exit 2 BEFORE any wire call', async () => {
    // No handler installed — confirmation must abort before the wire call.
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"CONFIRMATION_REQUIRED"');
  });
});

describe('freelo custom-fields delete — validation (exit 2)', () => {
  it('no input source → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('No custom-field uuids supplied');
  });

  it('positional + --ids → mutex error, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--ids',
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('exactly one input source');
  });

  it('malformed positional uuid → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      'not-a-uuid',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('malformed uuid in --ids → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      '--ids',
      `${UUID_A},nope`,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('NDJSON with malformed uuid line → per-line error envelope, exit 2', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"bad"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      // First line succeeded.
      expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.delete/v1');
      // Second line failed — VALIDATION_ERROR envelope.
      expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields delete — HTTP error paths (exit-code assertions)', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsCrudHandlers.deleteUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4', async () => {
    server.use(customFieldsCrudHandlers.deleteForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsCrudHandlers.deleteServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsCrudHandlers.deleteRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });

  it('multi-id with one 403 → per-uuid envelopes, exit 4', async () => {
    server.use(
      customFieldsCrudHandlers.deletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Forbidden.'] }), { status: 403 }),
        [UUID_C]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      UUID_B,
      UUID_C,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.delete/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[2] as { schema: string }).schema).toBe('freelo.custom-fields.delete/v1');
  });
});

describe('freelo custom-fields delete — introspect', () => {
  it('introspect entry shows destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields delete');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.delete/v1');
    expect(entry!.destructive).toBe(true);
  });
});

describe('isIdempotentDeleteSkip — direct unit test of the matrix', () => {
  it('returns true for httpStatus 404', () => {
    const err = new FreeloApiError('Not found.', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('returns false for 401', () => {
    const err = new FreeloApiError('Auth.', 'FREELO_API_ERROR', { httpStatus: 401 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('returns false for 403', () => {
    const err = new FreeloApiError('Forbidden.', 'FREELO_API_ERROR', { httpStatus: 403 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('returns false for 500', () => {
    const err = new FreeloApiError('Server.', 'FREELO_API_ERROR', { httpStatus: 500 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });
});

describe('freelo custom-fields delete — human output', () => {
  it('single delete --output human: prints "Deleted custom field <short>."', async () => {
    server.use(customFieldsCrudHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Deleted custom field 11111111/);
  });

  it('404 idempotent --output human: prints already-deleted line', async () => {
    server.use(
      customFieldsCrudHandlers.deletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ errors: ['Not found.'] }), { status: 404 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already deleted/i);
  });

  it('batch --output human with one failure: emits human error line for failed item', async () => {
    server.use(
      customFieldsCrudHandlers.deletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Forbidden.'] }), { status: 403 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toMatch(/Deleted custom field 11111111/);
    expect(stdout).toMatch(/Failed item 2 \(uuid /);
  });
});
