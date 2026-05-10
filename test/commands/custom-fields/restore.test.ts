/**
 * End-to-end tests for `freelo custom-fields restore` (R41, spec 0055).
 *
 * Covers:
 *   - Happy paths: single positional, multi positional, --ids, --stdin.
 *   - --dry-run skips the wire call.
 *   - **Single-arm idempotency (decision 3):** 404 → already_in_target_state: true,
 *     exit 0 — no `custom_field` echo on this path (decision 7).
 *   - Live success carries `custom_field` in envelope.
 *   - **No --yes flag** — restore is non-destructive (decision 2).
 *   - Validation: bad uuid (positional / --ids / NDJSON line), mutex inputs.
 *   - HTTP errors with exit codes (Calibration §2):
 *     401 → exit 3, 403 → exit 4, 5xx → exit 4, 429 → exit 6.
 *   - Introspect entry shows destructive: false.
 *   - Direct unit test for `isIdempotentRestoreSkip` matrix.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsCrudHandlers } from '../../msw/handlers.js';
import { isIdempotentRestoreSkip } from '../../../src/commands/custom-fields/restore.js';
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
    `freelo-cf-restore-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields restore — happy paths', () => {
  it('single positional: success envelope carries custom_field, exit 0', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        uuid: string;
        current_state: string;
        already_in_target_state: boolean;
        custom_field?: { uuid: string; name: string };
      };
    };
    expect(env.schema).toBe('freelo.custom-fields.restore/v1');
    expect(env.data.uuid).toBe(UUID_A);
    expect(env.data.current_state).toBe('active');
    expect(env.data.already_in_target_state).toBe(false);
    expect(env.data.custom_field).toBeDefined();
    expect(env.data.custom_field!.name).toBe('Severity');
  });

  it('multi positional: per-uuid envelopes', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      UUID_B,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('--ids comma-separated', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stdout } = await runCli(run, [
      'custom-fields',
      'restore',
      '--ids',
      `${UUID_A},${UUID_B}`,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(parseAllJsonLines(stdout)).toHaveLength(2);
  });

  it('--stdin NDJSON', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"${UUID_B}"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'restore',
        '--stdin',
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
        'restore',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('--dry-run echoes would', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
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
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/custom-field/restore/${UUID_A}`);
  });

  it('--output human renders the restore line', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Restored custom field');
  });
});

describe('freelo custom-fields restore — idempotency (single-arm 404)', () => {
  it('404 → already_in_target_state: true, exit 0, no custom_field on the skip path', async () => {
    server.use(customFieldsCrudHandlers.restoreNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        already_in_target_state: boolean;
        current_state: string;
        custom_field?: unknown;
      };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.current_state).toBe('active');
    expect(env.data.custom_field).toBeUndefined();
  });

  it('mixed 200 + 404 across multi-positional: both succeed, exit 0', async () => {
    server.use(
      customFieldsCrudHandlers.restorePerUuidRouter({
        [UUID_B]: () => new Response(JSON.stringify({ errors: ['Not found.'] }), { status: 404 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      UUID_B,
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

describe('freelo custom-fields restore — validation (exit 2)', () => {
  it('no input source → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'restore',
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
      'restore',
      UUID_A,
      '--ids',
      UUID_B,
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
      'restore',
      'not-a-uuid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('NDJSON with malformed uuid line → per-line error envelope, exit 2', async () => {
    server.use(customFieldsCrudHandlers.restoreOk());
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"bad"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'restore',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.restore/v1');
      expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields restore — HTTP error paths (exit-code assertions)', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsCrudHandlers.restoreUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4', async () => {
    server.use(customFieldsCrudHandlers.restoreForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsCrudHandlers.restoreServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsCrudHandlers.restoreRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields restore — introspect', () => {
  it('introspect entry shows destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields restore');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.restore/v1');
    expect(entry!.destructive).toBe(false);
  });
});

describe('isIdempotentRestoreSkip — direct unit test of the matrix', () => {
  it('returns true for httpStatus 404', () => {
    const err = new FreeloApiError('Not found.', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentRestoreSkip(err)).toBe(true);
  });

  it('returns false for 401', () => {
    const err = new FreeloApiError('Auth.', 'FREELO_API_ERROR', { httpStatus: 401 });
    expect(isIdempotentRestoreSkip(err)).toBe(false);
  });

  it('returns false for 403', () => {
    const err = new FreeloApiError('Forbidden.', 'FREELO_API_ERROR', { httpStatus: 403 });
    expect(isIdempotentRestoreSkip(err)).toBe(false);
  });

  it('returns false for 500', () => {
    const err = new FreeloApiError('Server.', 'FREELO_API_ERROR', { httpStatus: 500 });
    expect(isIdempotentRestoreSkip(err)).toBe(false);
  });
});

describe('freelo custom-fields restore — batch error paths', () => {
  const UUID_C = '33333333-3333-3333-3333-333333333333';

  it('multi-positional with one 5xx → exit 4, JSON error envelope carries input_index', async () => {
    server.use(
      customFieldsCrudHandlers.restorePerUuidRouter({
        [UUID_A]: () =>
          new Response(
            JSON.stringify({
              custom_field: {
                uuid: UUID_A,
                name: 'Severity',
                custom_field_type: {
                  uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                  slug: 'short_text',
                },
                project_id: 1,
                created_at: '2026-05-10T00:00:00+00:00',
                deleted_at: null,
              },
            }),
            { status: 200 },
          ),
        [UUID_B]: () =>
          new Response(JSON.stringify({ errors: ['Internal error.'] }), { status: 500 }),
        [UUID_C]: () =>
          new Response(
            JSON.stringify({
              custom_field: {
                uuid: UUID_C,
                name: 'Severity',
                custom_field_type: {
                  uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                  slug: 'short_text',
                },
                project_id: 1,
                created_at: '2026-05-10T00:00:00+00:00',
                deleted_at: null,
              },
            }),
            { status: 200 },
          ),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      UUID_B,
      UUID_C,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.restore/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
    const errEnv = lines[1] as { error: { context: { input_index?: number; uuid?: string } } };
    expect(errEnv.error.context.input_index).toBe(1);
    expect(errEnv.error.context.uuid).toBe(UUID_B);
    expect((lines[2] as { schema: string }).schema).toBe('freelo.custom-fields.restore/v1');
  });

  it('multi-positional with one 5xx --output human: emits human error line', async () => {
    server.use(
      customFieldsCrudHandlers.restorePerUuidRouter({
        [UUID_A]: () =>
          new Response(
            JSON.stringify({
              custom_field: {
                uuid: UUID_A,
                name: 'Severity',
                custom_field_type: {
                  uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
                  slug: 'short_text',
                },
                project_id: 1,
                created_at: '2026-05-10T00:00:00+00:00',
                deleted_at: null,
              },
            }),
            { status: 200 },
          ),
        [UUID_B]: () =>
          new Response(JSON.stringify({ errors: ['Internal error.'] }), { status: 500 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      UUID_B,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toMatch(/Restored custom field/);
    expect(stdout).toMatch(/Failed item 2 \(uuid /);
  });

  it('single 404 --output human: prints already-active line', async () => {
    server.use(
      customFieldsCrudHandlers.restorePerUuidRouter({
        [UUID_A]: () => new Response(JSON.stringify({ errors: ['Not found.'] }), { status: 404 }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'restore',
      UUID_A,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Already active/i);
  });
});
