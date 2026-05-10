/**
 * End-to-end tests for `freelo custom-fields enum list --field <uuid>` (R43, spec 0057).
 *
 * Read-only. No --dry-run (decision 7).
 *
 * Covers:
 *   - Happy paths: non-empty + empty `custom_field_enum: []`.
 *   - Validation: missing / empty `--field` (exit 2).
 *   - HTTP error matrix with exit-code assertions (Calibration §2):
 *     400 → exit 4, 401 → exit 3, 403 → exit 4, 404 → exit 4, 5xx → exit 4, 429 → exit 6.
 *   - Human-mode renderer (empty + non-empty).
 *   - Introspection lists the leaf with the right output_schema and
 *     destructive: false.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsEnumHandlers } from '../../msw/handlers.js';

const FIELD_UUID = 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

const SAMPLE_OPTIONS = [
  { uuid: 'opt-1111-1111', value: 'Low' },
  { uuid: 'opt-2222-2222', value: 'Medium' },
  { uuid: 'opt-3333-3333', value: 'High' },
];

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
    `freelo-cf-enum-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields enum list — happy paths', () => {
  it('returns options array, exit 0', async () => {
    server.use(customFieldsEnumHandlers.listOk(SAMPLE_OPTIONS));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { field_uuid: string; options: Array<{ uuid: string; value: string }> };
    };
    expect(env.schema).toBe('freelo.custom-fields.enum-list/v1');
    expect(env.data.field_uuid).toBe(FIELD_UUID);
    expect(env.data.options).toHaveLength(3);
    expect(env.data.options[0]).toEqual(SAMPLE_OPTIONS[0]);
  });

  it('empty array is a valid 200', async () => {
    server.use(customFieldsEnumHandlers.listEmpty());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { options: unknown[] } };
    expect(env.data.options).toEqual([]);
  });
});

describe('freelo custom-fields enum list — validation', () => {
  it('missing --field → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--field is required');
  });

  it('empty --field → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields enum list — HTTP error paths (exit-code assertions)', () => {
  it('400 → exit 4', async () => {
    server.use(customFieldsEnumHandlers.listBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsEnumHandlers.listUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4', async () => {
    server.use(customFieldsEnumHandlers.listForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4 with field-not-found hint', async () => {
    server.use(customFieldsEnumHandlers.listNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Custom field not found');
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsEnumHandlers.listServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsEnumHandlers.listRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields enum list — human output', () => {
  it('non-empty list prints "<value>  uuid=..." rows', async () => {
    server.use(customFieldsEnumHandlers.listOk(SAMPLE_OPTIONS));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/3 enum option/);
    expect(stdout).toMatch(/"Low"/);
    expect(stdout).toMatch(/"High"/);
  });

  it('empty list prints "no enum options"', async () => {
    server.use(customFieldsEnumHandlers.listEmpty());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'list',
      '--field',
      FIELD_UUID,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no enum options/);
  });
});

describe('freelo custom-fields enum list — introspect', () => {
  it('introspect entry shows destructive: false and the expected schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields enum list');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.enum-list/v1');
    expect(entry!.destructive).toBe(false);
  });
});
