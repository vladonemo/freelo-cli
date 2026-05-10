/**
 * End-to-end tests for `freelo notes show` (R44, spec 0058).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, notesHandlers } from '../../msw/handlers.js';

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

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-notes-show-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
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

describe('freelo notes show — happy paths', () => {
  it('--request-id threads through to envelope', async () => {
    server.use(notesHandlers.showOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'show',
      '1234',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('json: returns the note, schema matches', async () => {
    server.use(notesHandlers.showOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['notes', 'show', '1234', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { schema: string; data: { note: { id: number } } };
    expect(env.schema).toBe('freelo.notes.show/v1');
    expect(env.data.note.id).toBe(1234);
  });

  it('human: renders multi-line summary including "Note #1234"', async () => {
    server.use(notesHandlers.showOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['notes', 'show', '1234', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Note #1234');
    expect(stdout).toContain('Project:');
    expect(stdout).toContain('Author:');
  });
});

describe('freelo notes show — validation', () => {
  it('non-numeric <id>: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', 'abc']);
    expect(exitCode).toBe(2);
  });

  it('zero <id>: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', '0']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo notes show — HTTP errors', () => {
  it('403: exit 4 with permission hint', async () => {
    server.use(notesHandlers.showForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notes', 'show', '1234', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/permission/);
  });

  it('404: exit 4 with not-found hint mentioning leak protection', async () => {
    server.use(notesHandlers.showNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notes', 'show', '1234', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/not found|permission/);
  });

  it('404 human: writes a single-line error to stderr, exit 4', async () => {
    server.use(notesHandlers.showNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notes', 'show', '1234', '--output', 'human']);
    expect(exitCode).toBe(4);
    expect(stderr.length).toBeGreaterThan(0);
  });

  it('401: exit 3', async () => {
    server.use(notesHandlers.showUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', '1234']);
    expect(exitCode).toBe(3);
  });

  it('429: exit 6', async () => {
    server.use(notesHandlers.showRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', '1234']);
    expect(exitCode).toBe(6);
  });

  it('500: exit 4', async () => {
    server.use(notesHandlers.showServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', '1234']);
    expect(exitCode).toBe(4);
  });

  it('network: exit 5', async () => {
    server.use(notesHandlers.showNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'show', '1234']);
    expect(exitCode).toBe(5);
  });
});

describe('freelo notes show — introspect', () => {
  it('--introspect lists "notes show" with destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean; output_schema: string }> };
    };
    const show = env.data.commands.find((c) => c.name === 'notes show');
    expect(show).toBeDefined();
    expect(show!.destructive).toBe(false);
    expect(show!.output_schema).toBe('freelo.notes.show/v1');
  });
});
