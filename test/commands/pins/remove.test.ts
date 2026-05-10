/**
 * End-to-end tests for `freelo pins remove` (R44, spec 0058).
 *
 * Mirrors the `notes/delete.test.ts` shape minus the API quirk
 * (DELETE /pinned-item/<id> returns SuccessResponse, no body to echo).
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, pinsHandlers } from '../../msw/handlers.js';
import { isIdempotentRemoveSkip } from '../../../src/commands/pins/remove.js';
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

let testDir: string;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-pins-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo pins remove — happy paths', () => {
  it('--request-id threads through (live + 404 idempotent + dry-run)', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout: liveOut, exitCode: liveExit } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'json',
    ]);
    expect(liveExit).toBe(0);
    expect((parseFirstJson(liveOut) as { request_id?: string }).request_id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );

    server.resetHandlers();
    server.use(pinsHandlers.removeNotFound());
    const { stdout: idemOut, exitCode: idemExit } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'json',
    ]);
    expect(idemExit).toBe(0);
    expect((parseFirstJson(idemOut) as { request_id?: string }).request_id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );

    const { stdout: dryOut, exitCode: dryExit } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'remove',
      '99',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(dryExit).toBe(0);
    expect((parseFirstJson(dryOut) as { request_id?: string }).request_id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('single positional --yes (json): exit 0, schema, current_state=removed', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { pin_id: number; current_state: string; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.pins.remove/v1');
    expect(env.data.pin_id).toBe(99);
    expect(env.data.current_state).toBe('removed');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('single (human): "Removed pinned item #99." line', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Removed pinned item #99\.\s*$/);
  });

  it('multi positional: per-id envelopes', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '12',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('--ids comma-separated', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '--ids',
      '12,13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(parseAllJsonLines(stdout)).toHaveLength(2);
  });

  it('--stdin NDJSON', async () => {
    server.use(pinsHandlers.removeOk());
    const restore = pipeStdin('{"id": 12}\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'pins',
        'remove',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(parseAllJsonLines(stdout)).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

describe('freelo pins remove — idempotency', () => {
  it('404 → already_in_target_state: true, exit 0', async () => {
    server.use(pinsHandlers.removeNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { already_in_target_state: boolean } };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('404 (human): "Already removed: pinned item #99." line', async () => {
    server.use(pinsHandlers.removeNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '99',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Already removed: pinned item #99\.\s*$/);
  });

  it('isIdempotentRemoveSkip unit test', () => {
    const e404 = new FreeloApiError('not found', 'NOT_FOUND', { httpStatus: 404 });
    const e500 = new FreeloApiError('boom', 'SERVER_ERROR', { httpStatus: 500 });
    expect(isIdempotentRemoveSkip(e404)).toBe(true);
    expect(isIdempotentRemoveSkip(e500)).toBe(false);
  });
});

describe('freelo pins remove — confirmation policy', () => {
  it('non-TTY without --yes: exit 2 CONFIRMATION_REQUIRED', async () => {
    server.use(pinsHandlers.removeOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['pins', 'remove', '99', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
  });
});

describe('freelo pins remove — dry-run', () => {
  it('--dry-run: no wire call', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '99',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('DELETE');
    expect(env.data.would.path).toBe('/pinned-item/99');
  });
});

describe('freelo pins remove — stdin batch with malformed line', () => {
  it('json: malformed line emits error envelope with line_index', async () => {
    server.use(pinsHandlers.removeOk());
    const restore = pipeStdin('{"id": 12}\nnot-json\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'pins',
        'remove',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      const errLine = lines.find((l) => l['schema'] === 'freelo.error/v1') as
        | { error: { context: { line_index: number } } }
        | undefined;
      expect(errLine).toBeDefined();
      expect(errLine!.error.context.line_index).toBe(1);
    } finally {
      restore();
    }
  });

  it('human: malformed line + valid line: "Failed item" line, exit 2', async () => {
    server.use(pinsHandlers.removeOk());
    const restore = pipeStdin('{"id": 12}\nnot-json\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'pins',
        'remove',
        '--stdin',
        '--yes',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('Removed pinned item #12');
      expect(stdout).toMatch(/Failed item 2/);
    } finally {
      restore();
    }
  });

  it('empty stdin: silent success exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, ['pins', 'remove', '--stdin', '--yes']);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('stdin batch with wire 500: per-line error envelope, exit 4', async () => {
    server.use(pinsHandlers.removeByIdMatrix({ 12: 200, 13: 500 }));
    const restore = pipeStdin('{"id": 12}\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'pins',
        'remove',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.pins.remove/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      const errEnv = lines[1] as { error: { context: { line_index: number; pin_id: number } } };
      expect(errEnv.error.context.line_index).toBe(1);
      expect(errEnv.error.context.pin_id).toBe(13);
    } finally {
      restore();
    }
  });
});

describe('freelo pins remove — multi-id mid-stream failure (json + human)', () => {
  it('json: per-id envelopes with mixed stati, exit code = worst', async () => {
    server.use(pinsHandlers.removeByIdMatrix({ 12: 200, 13: 500 }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '12',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(lines[0]!['schema']).toBe('freelo.pins.remove/v1');
    expect(lines[1]!['schema']).toBe('freelo.error/v1');
    const errEnv = lines[1] as { error: { context: { pin_id: number } } };
    expect(errEnv.error.context.pin_id).toBe(13);
  });

  it('human: mixed renderer + "Failed item" for the failure', async () => {
    server.use(pinsHandlers.removeByIdMatrix({ 12: 200, 13: 500 }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'remove',
      '12',
      '13',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toContain('Removed pinned item #12');
    expect(stdout).toContain('Failed item 2 (pinned item #13)');
  });
});

describe('freelo pins remove — HTTP errors', () => {
  it('401 → exit 3', async () => {
    server.use(pinsHandlers.removeUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '99', '--yes']);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(pinsHandlers.removeForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '99', '--yes']);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(pinsHandlers.removeServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '99', '--yes']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(pinsHandlers.removeRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '99', '--yes']);
    expect(exitCode).toBe(6);
  });
});

describe('freelo pins remove — validation', () => {
  it('mutex: positional + --ids → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '12', '--ids', '13', '--yes']);
    expect(exitCode).toBe(2);
  });

  it('no source: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', '--yes']);
    expect(exitCode).toBe(2);
  });

  it('non-numeric positional: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'remove', 'abc', '--yes']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo pins remove — introspect', () => {
  it('--introspect: "pins remove" with destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean }> };
    };
    const rm = env.data.commands.find((c) => c.name === 'pins remove');
    expect(rm).toBeDefined();
    expect(rm!.destructive).toBe(true);
  });
});
