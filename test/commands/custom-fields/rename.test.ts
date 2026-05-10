/**
 * End-to-end tests for `freelo custom-fields rename` (R41, spec 0055).
 *
 * Covers:
 *   - Happy path: <uuid> --name → POST → JSON envelope, exit 0.
 *   - Body round-trip via renameOkWhenBody (body has only { name }).
 *   - --dry-run: no wire call, envelope echoes `would`, exit 0.
 *   - --output human renders the rename line.
 *   - Validation: malformed <uuid> (exit 2), missing --name (exit 2),
 *     empty --name (exit 2). Each ValidationError trigger asserted (Calibration §1-2).
 *   - HTTP errors with exit codes (Calibration §2):
 *     401 → exit 3, 403 → exit 4, 404 → exit 4 (NOT idempotent — rename of
 *     deleted is a real failure, decision 6), 5xx → exit 4, 429 → exit 6.
 *   - Introspect entry shows destructive: false.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsCrudHandlers } from '../../msw/handlers.js';

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

const FIELD_UUID = '11111111-1111-1111-1111-111111111111';

let testDir: string;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-cf-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

describe('freelo custom-fields rename — happy paths', () => {
  it('emits success envelope with applied_changes, exit 0', async () => {
    server.use(customFieldsCrudHandlers.renameOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'Points',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { uuid: string; applied_changes: { name?: string } };
    };
    expect(env.schema).toBe('freelo.custom-fields.rename/v1');
    expect(env.data.uuid).toBe(FIELD_UUID);
    expect(env.data.applied_changes.name).toBe('Points');
  });

  it('body shape is exactly { name }', async () => {
    let captured: unknown;
    server.use(
      customFieldsCrudHandlers.renameOkWhenBody((body) => {
        captured = body;
        return true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'Points',
      '--output',
      'json',
    ]);
    expect(captured).toEqual({ name: 'Points' });
  });

  it('--dry-run skips the wire call', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'Points',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: true;
      data: { uuid: string; would: { method: string; path: string; body: unknown } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/custom-field/rename/${FIELD_UUID}`);
    expect(env.data.would.body).toEqual({ name: 'Points' });
  });

  it('--output human renders the rename line', async () => {
    server.use(customFieldsCrudHandlers.renameOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'Points',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Renamed custom field');
    expect(stdout).toContain('"Points"');
  });
});

describe('freelo custom-fields rename — validation (exit 2)', () => {
  it('malformed <uuid> → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      'not-a-uuid',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('"VALIDATION_ERROR"');
  });

  it('missing --name → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('--name');
  });

  it('empty --name → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields rename — HTTP error paths (exit-code assertions)', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(customFieldsCrudHandlers.renameUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('"AUTH_EXPIRED"');
  });

  it('403 → exit 4 with project-commander hint', async () => {
    server.use(customFieldsCrudHandlers.renameForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('project commander');
  });

  it('404 → exit 4 with field-not-found hint (NOT idempotent)', async () => {
    server.use(customFieldsCrudHandlers.renameNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Custom field not found');
  });

  it('400 → exit 4 with generic validation hint', async () => {
    server.use(customFieldsCrudHandlers.renameBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('Server-side validation');
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsCrudHandlers.renameServerError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(customFieldsCrudHandlers.renameRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'custom-fields',
      'rename',
      FIELD_UUID,
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('"RATE_LIMITED"');
  });
});

describe('freelo custom-fields rename — introspect', () => {
  it('introspect entry shows output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields rename');
    expect(entry).toBeDefined();
    expect(entry!.output_schema).toBe('freelo.custom-fields.rename/v1');
    expect(entry!.destructive).toBe(false);
  });
});
