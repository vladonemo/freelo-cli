/**
 * End-to-end tests for `freelo custom-fields enum rename <enum_uuid> --value <str>`
 * (R43, spec 0057).
 *
 * Single-shot, non-destructive. NOT idempotent — 404 bubbles. Covers:
 *   - Happy path: live POST to /custom-field-enum/change/<uuid>.
 *   - --dry-run: no wire call; would echoes POST + body.
 *   - Validation: empty positional / missing/empty --value → exit 2.
 *   - HTTP error matrix with exit codes:
 *     400 → 4, 401 → 3, 403 → 4, 404 → 4 (NOT idempotent), 5xx → 4, 429 → 6.
 *   - Human-mode renderer (live + dry-run).
 *   - Introspection lists the leaf with the right schema.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsEnumHandlers } from '../../msw/handlers.js';

const ENUM_UUID = 'bbbb2222-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

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
    `freelo-cf-enum-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields enum rename — happy paths', () => {
  it('live rename: POSTs to change/<uuid> with { value }', async () => {
    server.use(
      customFieldsEnumHandlers.renameOkWhenBody(
        (body) => (body as { value?: unknown }).value === 'New Label',
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'New Label',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { uuid: string; applied_changes: { value: string } };
    };
    expect(env.schema).toBe('freelo.custom-fields.enum-rename/v1');
    expect(env.data.uuid).toBe(ENUM_UUID);
    expect(env.data.applied_changes.value).toBe('New Label');
  });

  it('--dry-run: no wire call; would echoes POST + body', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'New Label',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        uuid: string;
        applied_changes: { value: string };
        would: { method: string; path: string; body: { value: string } };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.uuid).toBe(ENUM_UUID);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/custom-field-enum/change/${ENUM_UUID}`);
    expect(env.data.would.body.value).toBe('New Label');
  });

  it('trims whitespace around --value', async () => {
    server.use(
      customFieldsEnumHandlers.renameOkWhenBody(
        (body) => (body as { value?: string }).value === 'Trimmed',
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      '  Trimmed  ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });
});

describe('freelo custom-fields enum rename — validation', () => {
  it('missing --value → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
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
      'rename',
      ENUM_UUID,
      '--value',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('whitespace-only positional <enum_uuid> → exit 2 (covers parseUuidArg empty-after-trim branch)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      '   ',
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('<enum_uuid> must be a non-empty uuid');
  });
});

describe('freelo custom-fields enum rename — HTTP error paths (exit-code assertions)', () => {
  it('400 → exit 4', async () => {
    server.use(customFieldsEnumHandlers.renameBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsEnumHandlers.renameUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4 with commander hint', async () => {
    server.use(customFieldsEnumHandlers.renameForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('project commander');
  });

  it('404 → exit 4 (NOT idempotent — bubbles)', async () => {
    server.use(customFieldsEnumHandlers.renameNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Enum option not found');
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsEnumHandlers.renameServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsEnumHandlers.renameRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields enum rename — human output', () => {
  it('live rename: prints "Renamed enum option ..."', async () => {
    server.use(customFieldsEnumHandlers.renameOk({ uuid: ENUM_UUID, value: 'New Label' }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'New Label',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/Renamed enum option/);
    expect(stdout).toMatch(/"New Label"/);
  });

  it('--dry-run prints "[dry-run] Would rename..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'enum',
      'rename',
      ENUM_UUID,
      '--value',
      'New Label',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/\[dry-run\] Would rename/);
  });
});

describe('freelo custom-fields enum rename — introspect', () => {
  it('shows destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields enum rename');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.enum-rename/v1');
    expect(entry!.destructive).toBe(false);
  });
});
