/**
 * End-to-end tests for `freelo labels list` (R23, spec 0035).
 *
 * Covers:
 *   - Happy paths: multiple labels, empty array, --output human (table renderer).
 *   - Schema-validation: malformed wire body → ValidationError exit 2.
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4), 429 (exit 6), network (exit 5).
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * Calibration §1-2: every typed-error path that the spec assigns an exit code
 * has at least one assertion.
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
    `freelo-labels-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const BILLABLE = {
  id: 12,
  name: 'Billable',
  color: '#9b59b6',
  is_private: false,
  users_id: 42,
  usage_count: 7,
  can_be_public: true,
  can_be_edited: true,
};

const ON_HOLD = {
  id: 13,
  name: 'On hold',
  color: '#ff0000',
  is_private: true,
  users_id: 42,
  usage_count: 0,
  can_be_public: true,
  can_be_edited: true,
};

describe('freelo labels list — happy paths', () => {
  it('multiple labels: emits envelope with labels[], exit 0', async () => {
    server.use(projectLabelsHandlers.findAvailableOk([BILLABLE, ON_HOLD]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { labels: Array<{ id: number; name?: string }> };
    };
    expect(env.schema).toBe('freelo.labels.list/v1');
    expect(env.data.labels).toHaveLength(2);
    expect(env.data.labels[0]!.id).toBe(12);
    expect(env.data.labels[1]!.id).toBe(13);
  });

  it('empty array: emits envelope with labels: []', async () => {
    server.use(projectLabelsHandlers.findAvailableOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { labels: unknown[] } };
    expect(env.data.labels).toEqual([]);
  });

  it('human output: renders a table including the label name', async () => {
    server.use(projectLabelsHandlers.findAvailableOk([BILLABLE]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['labels', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Billable');
    expect(stdout).toContain('#9b59b6');
  });

  it('human output: empty list shows the (no labels) placeholder row', async () => {
    server.use(projectLabelsHandlers.findAvailableOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['labels', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no labels)');
  });

  it('human output: tolerates labels with null/undefined fields', async () => {
    const partial = { id: 99, name: null, color: null, is_private: null, usage_count: null };
    server.use(projectLabelsHandlers.findAvailableOk([partial]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['labels', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('99');
    expect(stdout).toContain('-');
  });
});

describe('freelo labels list — error paths', () => {
  it('401 → exit 3 (FreeloApiError)', async () => {
    server.use(projectLabelsHandlers.findAvailableUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx → exit 4 (FreeloApiError)', async () => {
    server.use(projectLabelsHandlers.findAvailableServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6 (RateLimitedError)', async () => {
    server.use(projectLabelsHandlers.findAvailableRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(6);
  });

  it('network error → exit 5 (NetworkError)', async () => {
    server.use(projectLabelsHandlers.findAvailableNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(5);
  });

  it('malformed body → FreeloApiError VALIDATION_ERROR exit 4', async () => {
    server.use(projectLabelsHandlers.findAvailableMalformed());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, ['labels', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const blob = stdout + stderr;
    expect(blob).toContain('VALIDATION_ERROR');
  });
});

describe('freelo labels list — request-id propagation', () => {
  it('--request-id is forwarded into the response envelope', async () => {
    const reqId = '550e8400-e29b-41d4-a716-446655440000';
    server.use(projectLabelsHandlers.findAvailableOk([BILLABLE]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      reqId,
      'labels',
      'list',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(reqId);
  });
});

describe('freelo labels list — introspect', () => {
  it('lists labels list with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'labels list');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.labels.list/v1');
    expect(entry?.destructive).toBe(false);
  });
});
