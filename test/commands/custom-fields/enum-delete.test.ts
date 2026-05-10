/**
 * End-to-end tests for `freelo custom-fields enum delete <enum_uuid>... [--force] [--yes]`
 * (R43, spec 0057).
 *
 * Covers (mirrors `custom-fields delete.test.ts` plus the --force matrix):
 *   - Happy paths: single + multi positional, --ids, --stdin, --dry-run.
 *   - --force routes to the cascading endpoint (different MSW path).
 *   - Single-arm 404 idempotency (decision 4): both safe and force.
 *   - Mixed safe + force scenarios for clarity in the audit trail.
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED, exit 2,
 *     BEFORE any wire call (true for both --force and safe path).
 *   - Validation: bad uuid (positional / --ids / NDJSON line), mutex inputs,
 *     no input source → exit 2.
 *   - HTTP errors with exit codes:
 *     401 → 3, 403 → 4, 5xx → 4, 429 → 6, 400 in-use safe → 4 with --force hint.
 *   - Multi-id mid-stream-failure in BOTH json and human modes (R42 calibration).
 *   - Direct unit test for `isIdempotentDeleteSkip` matrix.
 *   - Introspect entry shows destructive: true.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsEnumHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/custom-fields/enum/delete.js';
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

const UUID_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

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
    `freelo-cf-enum-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields enum delete — happy paths (safe)', () => {
  it('single positional with --yes: success envelope, force: false', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        uuid: string;
        force: boolean;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.custom-fields.enum-delete/v1');
    expect(env.data.uuid).toBe(UUID_A);
    expect(env.data.force).toBe(false);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi positional: per-uuid envelopes', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
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
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
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

  it('--stdin NDJSON: line_index is set per envelope', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"${UUID_B}"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'enum',
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
        'enum',
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

  it('--dry-run (safe): no wire call; would.path is /custom-field-enum/delete/<uuid>', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { uuid: string; force: boolean; would: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.force).toBe(false);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe(`/custom-field-enum/delete/${UUID_A}`);
  });
});

describe('freelo custom-fields enum delete — happy paths (--force)', () => {
  it('single --force: routes to force-delete endpoint, force=true in envelope', async () => {
    server.use(customFieldsEnumHandlers.forceDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { uuid: string; force: boolean; current_state: string };
    };
    expect(env.data.uuid).toBe(UUID_A);
    expect(env.data.force).toBe(true);
    expect(env.data.current_state).toBe('deleted');
  });

  it('--dry-run --force: would.path is /custom-field-enum/force-delete/<uuid>', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { force: boolean; would: { method: string; path: string } };
    };
    expect(env.data.force).toBe(true);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe(`/custom-field-enum/force-delete/${UUID_A}`);
  });

  it('--force routes to /custom-field-enum/force-delete (NOT /delete): unhandled-by-safe-handler errors out', async () => {
    // Pin the routing: when --force is on, only the safe handler is installed;
    // MSW's onUnhandledRequest: 'error' makes the fetch fail, which surfaces
    // as a non-zero exit. Asserting non-zero (vs the safe-handler 200) is the
    // load-bearing observation — the exact code (4 NetworkError vs 5 generic)
    // depends on undici internals on the matrix.
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).not.toBe(0);
  });
});

describe('freelo custom-fields enum delete — idempotency (single-arm 404)', () => {
  it('safe 404 → already_in_target_state: true, exit 0', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; force: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.force).toBe(false);
  });

  it('force 404 → already_in_target_state: true, exit 0', async () => {
    server.use(customFieldsEnumHandlers.forceDeleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; force: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.force).toBe(true);
  });

  it('mixed 200 + 404 across multi-positional (safe): both succeed, exit 0', async () => {
    server.use(
      customFieldsEnumHandlers.safeDeletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Not found.'] }), { status: 404 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
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

describe('freelo custom-fields enum delete — confirmation policy', () => {
  it('non-TTY without --yes (safe) → CONFIRMATION_REQUIRED exit 2 BEFORE wire call', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"CONFIRMATION_REQUIRED"');
  });

  it('non-TTY without --yes (--force) → CONFIRMATION_REQUIRED exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"CONFIRMATION_REQUIRED"');
  });
});

describe('freelo custom-fields enum delete — validation (exit 2)', () => {
  it('no input source → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('No enum-option uuids supplied');
  });

  it('positional + --ids → mutex, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
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

  it('NDJSON line with malformed uuid → per-line error envelope, exit 2', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":""}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'enum',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.enum-delete/v1');
      expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields enum delete — HTTP error paths (exit codes)', () => {
  it('400 in-use (safe path) → exit 4 with --force hint', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteInUse());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('--force');
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
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
    server.use(customFieldsEnumHandlers.safeDeleteForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });

  it('multi-id with one 403 (json): per-uuid envelopes, exit 4', async () => {
    server.use(
      customFieldsEnumHandlers.safeDeletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Forbidden.'] }), { status: 403 }),
        [UUID_C]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
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
    expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.enum-delete/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[2] as { schema: string }).schema).toBe('freelo.custom-fields.enum-delete/v1');
  });
});

describe('freelo custom-fields enum delete — human output', () => {
  it('single safe delete --output human: prints "Deleted enum option ..."', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Deleted enum option/);
  });

  it('single --force --output human: prints "Force-deleted enum option ..."', async () => {
    server.use(customFieldsEnumHandlers.forceDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Force-deleted enum option/);
    expect(stdout).toMatch(/cleared/);
  });

  it('404 idempotent --output human: prints already-deleted line', async () => {
    server.use(customFieldsEnumHandlers.safeDeleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already deleted/i);
  });

  it('--dry-run --force --output human: prints "[dry-run] Would force-delete..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      '--force',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[dry-run\] Would force-delete/);
  });

  it('batch --output human with one failure: emits human error line for failed item', async () => {
    server.use(
      customFieldsEnumHandlers.safeDeletePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ result: 'success' }), { status: 200 }),
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Forbidden.'] }), { status: 403 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toMatch(/Deleted enum option/);
    expect(stdout).toMatch(/Failed item 2 \(uuid /);
  });

  it('multi-positional --force --yes: routes to force-delete and uses multi-force confirm copy (covers confirmMessage force-multi branch)', async () => {
    server.use(customFieldsEnumHandlers.forceDeleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'delete',
      UUID_A,
      UUID_B,
      '--force',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { data: { force: boolean } }).data.force).toBe(true);
    expect((lines[1] as { data: { force: boolean } }).data.force).toBe(true);
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

  it('returns false for 400 (in-use)', () => {
    const err = new FreeloApiError('In use.', 'FREELO_API_ERROR', { httpStatus: 400 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('returns false for 500', () => {
    const err = new FreeloApiError('Server.', 'FREELO_API_ERROR', { httpStatus: 500 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });
});

describe('freelo custom-fields enum delete — introspect', () => {
  it('introspect entry shows destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields enum delete');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.enum-delete/v1');
    expect(entry!.destructive).toBe(true);
  });
});
