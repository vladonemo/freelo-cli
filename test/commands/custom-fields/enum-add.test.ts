/**
 * End-to-end tests for `freelo custom-fields enum add --field <uuid> --value <str>`
 * (R43, spec 0057).
 *
 * Single-shot, non-destructive. Covers:
 *   - Happy path: live POST returns option + envelope.
 *   - --dry-run: no wire call, would.method/path/body echoed.
 *   - Validation: missing/empty field/value → exit 2.
 *   - HTTP error matrix with exit codes (Calibration §2):
 *     400 (value-mention + generic), 401 → 3, 403 → 4, 404 → 4, 5xx → 4, 429 → 6.
 *   - Human-mode renderer (live + dry-run).
 *   - Introspection lists the leaf with the right schema.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsEnumHandlers } from '../../msw/handlers.js';

const FIELD_UUID = 'aaaa1111-aaaa-aaaa-aaaa-aaaaaaaaaaaa';

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
    `freelo-cf-enum-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields enum add — happy paths', () => {
  it('live add: posts body and returns envelope with option', async () => {
    server.use(
      customFieldsEnumHandlers.addOkWhenBody(
        (body) =>
          typeof body === 'object' &&
          body !== null &&
          (body as { value?: unknown }).value === 'Critical',
        { uuid: 'opt-new', value: 'Critical' },
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'Critical',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { field_uuid: string; option?: { uuid: string; value: string } };
    };
    expect(env.schema).toBe('freelo.custom-fields.enum-add/v1');
    expect(env.data.field_uuid).toBe(FIELD_UUID);
    expect(env.data.option?.uuid).toBe('opt-new');
    expect(env.data.option?.value).toBe('Critical');
  });

  it('--dry-run: no wire call; would echoes POST + body', async () => {
    // No handler installed — confirms no wire call fires.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'Critical',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        field_uuid: string;
        would: { method: string; path: string; body: { value: string } };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.field_uuid).toBe(FIELD_UUID);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/custom-field-enum/create/${FIELD_UUID}`);
    expect(env.data.would.body.value).toBe('Critical');
  });

  it('trims whitespace around --value before sending', async () => {
    server.use(
      customFieldsEnumHandlers.addOkWhenBody(
        (body) => (body as { value?: string }).value === 'Trimmed',
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      '  Trimmed  ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });
});

describe('freelo custom-fields enum add — validation', () => {
  it('missing --field → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--field is required');
  });

  it('missing --value → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--value');
  });

  it('whitespace-only --value → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('whitespace-only --field → exit 2 (covers parseFieldFlag empty-after-trim branch)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      '   ',
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--field must be a non-empty uuid');
  });
});

describe('freelo custom-fields enum add — HTTP error paths (exit-code assertions)', () => {
  it('400 mentioning value → exit 4 with --value hint', async () => {
    server.use(customFieldsEnumHandlers.addBadRequest('value is required.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('--value');
  });

  it('400 generic → exit 4 with non-enum hint', async () => {
    server.use(customFieldsEnumHandlers.addBadRequest('Custom field is not enum-typed.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toMatch(/not enum-typed|Server-side validation/);
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsEnumHandlers.addUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4 with commander hint', async () => {
    server.use(customFieldsEnumHandlers.addForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('project commander');
  });

  it('404 → exit 4 with field-not-found hint', async () => {
    server.use(customFieldsEnumHandlers.addNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Custom field not found');
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsEnumHandlers.addServerError(502));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsEnumHandlers.addRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields enum add — human output', () => {
  it('live add prints "Added enum option ..."', async () => {
    server.use(customFieldsEnumHandlers.addOk({ uuid: 'opt-9999', value: 'Critical' }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'Critical',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Added enum option "Critical"/);
  });

  it('--dry-run prints "[dry-run] Would add ..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'add',
      '--field',
      FIELD_UUID,
      '--value',
      'Critical',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[dry-run\] Would add enum option "Critical"/);
  });
});

describe('freelo custom-fields enum add — introspect', () => {
  it('shows destructive: false and right schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields enum add');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.enum-add/v1');
    expect(entry!.destructive).toBe(false);
  });
});
