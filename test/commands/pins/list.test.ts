/**
 * End-to-end tests for `freelo pins list` (R44, spec 0058).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, pinsHandlers } from '../../msw/handlers.js';

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
const PROJECT_ID = 100;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-pins-list-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  vi.doMock('conf', () => ({
    default: vi.fn().mockImplementation(() => ({
      get path() {
        return join(testDir, 'config.json');
      },
      has: () => false,
      get store() {
        return {};
      },
      set store(_: unknown) {},
    })),
  }));
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

describe('freelo pins list — happy paths', () => {
  it('--request-id threads through to envelope', async () => {
    server.use(pinsHandlers.listOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('json: returns flat array as data.pins', async () => {
    server.use(pinsHandlers.listOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; pins: Array<{ id: number; link?: string }> };
    };
    expect(env.schema).toBe('freelo.pins.list/v1');
    expect(env.data.project_id).toBe(PROJECT_ID);
    expect(env.data.pins).toHaveLength(2);
    expect(env.data.pins[0]!.id).toBe(1);
  });

  it('json empty: data.pins = []', async () => {
    server.use(pinsHandlers.listEmpty(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { pins: unknown[] } };
    expect(env.data.pins).toEqual([]);
  });

  it('human empty: prints "no pinned items"', async () => {
    server.use(pinsHandlers.listEmpty(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Project #100');
    expect(stdout).toContain('no pinned items');
  });

  it('human happy: renders a table with ID and TITLE', async () => {
    server.use(pinsHandlers.listOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ID');
    expect(stdout).toContain('TITLE');
    expect(stdout).toContain('Spec doc');
  });
});

describe('freelo pins list — validation', () => {
  it('missing --project: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list']);
    expect(exitCode).toBe(2);
  });

  it('--project non-numeric: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list', '--project', 'abc']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo pins list — HTTP errors', () => {
  it('403 → exit 4 with permission hint', async () => {
    server.use(pinsHandlers.listForbidden(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'pins',
      'list',
      '--project',
      String(PROJECT_ID),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/permission/);
  });

  it('404 → exit 4', async () => {
    server.use(pinsHandlers.listNotFound(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list', '--project', String(PROJECT_ID)]);
    expect(exitCode).toBe(4);
  });

  it('401 → exit 3', async () => {
    server.use(pinsHandlers.listUnauthorized(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list', '--project', String(PROJECT_ID)]);
    expect(exitCode).toBe(3);
  });

  it('429 → exit 6', async () => {
    server.use(pinsHandlers.listRateLimited(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list', '--project', String(PROJECT_ID)]);
    expect(exitCode).toBe(6);
  });

  it('500 → exit 4', async () => {
    server.use(pinsHandlers.listServerError(PROJECT_ID, 500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'list', '--project', String(PROJECT_ID)]);
    expect(exitCode).toBe(4);
  });
});

describe('freelo pins list — introspect', () => {
  it('--introspect: "pins list" with destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean; output_schema: string }> };
    };
    const list = env.data.commands.find((c) => c.name === 'pins list');
    expect(list).toBeDefined();
    expect(list!.destructive).toBe(false);
    expect(list!.output_schema).toBe('freelo.pins.list/v1');
  });
});
