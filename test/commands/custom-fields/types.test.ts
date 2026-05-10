/**
 * End-to-end tests for `freelo custom-fields types` (R40, spec 0054).
 *
 * Read-only, no flags, no positional args. Covers:
 *   - Happy path 200 with three documented type rows.
 *   - Happy path 200 with empty types array.
 *   - Human render lines.
 *   - HTTP errors: 401 (exit 3), 429 (exit 6), 5xx (exit 4), network (exit 5).
 *   - Introspection lists the leaf with the right output_schema.
 *
 * No --dry-run flag (decision 5 — read-only).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsTypesHandlers } from '../../msw/handlers.js';

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
  testDir = join(tmpdir(), `freelo-cf-types-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo custom-fields types — happy paths', () => {
  it('200 with three type rows: envelope carries them', async () => {
    server.use(customFieldsTypesHandlers.ok());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { types: Array<{ uuid: string; name: string }> };
    };
    expect(env.schema).toBe('freelo.custom-fields.types/v1');
    expect(env.data.types).toHaveLength(3);
    expect(env.data.types.map((t) => t.name)).toEqual(['text', 'number', 'enum']);
    expect(env.data.types[0]?.uuid).toBe('2f7bfe3a-c950-470e-b910-95b4caf5dc4f');
  });

  it('200 with empty types: envelope `types: []`', async () => {
    server.use(customFieldsTypesHandlers.okEmpty());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { types: unknown[] } };
    expect(env.data.types).toEqual([]);
  });

  it('200 with custom type rows (passthrough): unknown future types preserved', async () => {
    server.use(
      customFieldsTypesHandlers.ok([
        { uuid: 'aaaa1111-bbbb-2222-cccc-dddd33334444', name: 'date', extra_field: 'kept' },
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { types: Array<{ uuid: string; name: string; extra_field?: string }> };
    };
    expect(env.data.types).toHaveLength(1);
    expect(env.data.types[0]?.name).toBe('date');
    // passthrough: extra_field survives through zod
    expect(env.data.types[0]?.extra_field).toBe('kept');
  });

  it('human mode: lists each type name + uuid', async () => {
    server.use(customFieldsTypesHandlers.ok());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'human']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('text');
    expect(stdout).toContain('number');
    expect(stdout).toContain('enum');
    expect(stdout).toContain('2f7bfe3a-c950-470e-b910-95b4caf5dc4f');
  });

  it('human mode: empty catalog prints "no custom-field types."', async () => {
    server.use(customFieldsTypesHandlers.okEmpty());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'human']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('no custom-field types');
  });
});

describe('freelo custom-fields types — HTTP errors', () => {
  it('401 → exit 3 (AUTH_EXPIRED)', async () => {
    server.use(customFieldsTypesHandlers.unauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('429 → exit 6 (RateLimitedError)', async () => {
    server.use(customFieldsTypesHandlers.rateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);
    expect(exitCode).toBe(6);
  });

  it('5xx → exit 4 (FreeloApiError SERVER_ERROR)', async () => {
    server.use(customFieldsTypesHandlers.serverError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('network failure → exit 5 (NetworkError)', async () => {
    server.use(customFieldsTypesHandlers.networkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['custom-fields', 'types', '--output', 'json']);
    expect(exitCode).toBe(5);
  });
});

describe('freelo custom-fields types — request-id propagation', () => {
  it('--request-id is forwarded into the response envelope', async () => {
    const reqId = '550e8400-e29b-41d4-a716-446655440000';
    server.use(customFieldsTypesHandlers.ok());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      reqId,
      'custom-fields',
      'types',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(reqId);
  });
});

describe('freelo custom-fields types — introspection', () => {
  it('--introspect lists the leaf with the right schema and destructive flag', async () => {
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
    const leaf = env.data.commands.find((c) => c.name === 'custom-fields types');
    expect(leaf).toBeDefined();
    expect(leaf?.output_schema).toBe('freelo.custom-fields.types/v1');
    expect(leaf?.destructive).toBe(false);
  });
});
