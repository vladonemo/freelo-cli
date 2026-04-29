/**
 * End-to-end tests for `freelo labels rename` (R23, spec 0035).
 *
 * Covers:
 *   - Happy paths: --name, --color, --is-private, --is-public, all together,
 *     dry-run, --output human.
 *   - Body round-trip: editOkWhenBody asserts wire body shape.
 *   - Validation: bad <id> (exit 2), bad --color (exit 2), empty edit (exit 2),
 *     mutex --is-private + --is-public (exit 2). Each ValidationError trigger
 *     gets its own assertion (Calibration §1-2).
 *   - HTTP errors: 401 (exit 3), 403 (exit 4), 404 (exit 4 — hard error, NOT
 *     idempotent), 5xx (exit 4), 429 (exit 6).
 *   - Introspect entry shows output_schema and destructive: false.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectLabelsHandlers } from '../../msw/handlers.js';

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
    `freelo-labels-rename-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo labels rename — happy paths', () => {
  it('--name only: success envelope, exit 0', async () => {
    server.use(
      projectLabelsHandlers.editOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return (
          b['name'] === 'Billable' && b['color'] === undefined && b['is_private'] === undefined
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'Billable',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { label_id: number; applied_changes: Record<string, unknown> };
    };
    expect(env.schema).toBe('freelo.labels.rename/v1');
    expect(env.data.label_id).toBe(12);
    expect(env.data.applied_changes).toEqual({ name: 'Billable' });
  });

  it('--color only: success envelope', async () => {
    server.use(
      projectLabelsHandlers.editOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['color'] === '#9b59b6';
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--hex',
      '#9b59b6',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ color: '#9b59b6' });
  });

  it('--is-private flips wire body to is_private: true', async () => {
    server.use(
      projectLabelsHandlers.editOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['is_private'] === true;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--is-private',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ is_private: true });
  });

  it('--is-public flips wire body to is_private: false', async () => {
    server.use(
      projectLabelsHandlers.editOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['is_private'] === false;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--is-public',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({ is_private: false });
  });

  it('all flags together: applied_changes carries every key', async () => {
    server.use(projectLabelsHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'Billable',
      '--hex',
      '#9b59b6',
      '--is-public',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: Record<string, unknown> };
    };
    expect(env.data.applied_changes).toEqual({
      name: 'Billable',
      color: '#9b59b6',
      is_private: false,
    });
  });

  it('--dry-run: skips POST, envelope has dry_run + would', async () => {
    // No handler registered — if it were called, MSW would 500.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'Billable',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { method: string; path: string; body: Record<string, unknown> } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/project-labels/12');
    expect(env.data.would?.body).toEqual({ name: 'Billable' });
  });

  it('human output: prints "Renamed label #ID..."', async () => {
    server.use(projectLabelsHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'Billable',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Renamed label #12');
    expect(stdout).toContain('Billable');
  });
});

describe('freelo labels rename — validation', () => {
  it('bad <id> (zero) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '0',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/positive integer|VALIDATION/);
  });

  it('bad --hex (3-digit) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--hex',
      '#abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/RRGGBB|VALIDATION/);
  });

  it('empty edit (no flags) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/at least one|VALIDATION/);
  });

  it('mutex --is-private + --is-public → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--is-private',
      '--is-public',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/mutually exclusive|VALIDATION/);
  });
});

describe('freelo labels rename — error paths', () => {
  it('401 → exit 3', async () => {
    server.use(projectLabelsHandlers.editUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4 (FORBIDDEN)', async () => {
    server.use(projectLabelsHandlers.editForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4 (NOT_FOUND, hard error — rename is NOT idempotent)', async () => {
    server.use(projectLabelsHandlers.editNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(projectLabelsHandlers.editServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(projectLabelsHandlers.editRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'rename',
      '12',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });
});

describe('freelo labels rename — introspect', () => {
  it('lists labels rename with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'labels rename');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.labels.rename/v1');
    expect(entry?.destructive).toBe(false);
  });
});
