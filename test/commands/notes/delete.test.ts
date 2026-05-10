/**
 * End-to-end tests for `freelo notes delete` (R44, spec 0058).
 *
 * Covers:
 *   - Happy: single positional --yes, multi positional, --ids, --stdin (json + human).
 *   - --dry-run skips both confirmation and the wire call.
 *   - Single-arm 404 idempotency: already_in_target_state: true, exit 0.
 *   - API quirk: live 200 envelope echoes the deleted Note's last state.
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Multi-id mid-stream-failure case in BOTH json and human output modes
 *     (Calibration §4 / R42 lessons).
 *   - HTTP errors: 401, 403, 5xx, 429.
 *   - isIdempotentDeleteSkip unit test.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, notesHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/notes/delete.js';
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
    `freelo-notes-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo notes delete — happy paths', () => {
  it('--request-id threads through to live envelope', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('--request-id + --dry-run: envelope carries request_id and dry_run', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'delete',
      '1234',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string; dry_run?: boolean };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(env.dry_run).toBe(true);
  });

  it('--request-id + 404 idempotent: envelope carries request_id', async () => {
    server.use(notesHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      request_id?: string;
      data: { already_in_target_state: boolean };
    };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('single positional --yes: exit 0, schema, data.note carries deleted Note (API quirk)', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        note_id: number;
        note?: { id: number; name: string };
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.notes.delete/v1');
    expect(env.data.note_id).toBe(1234);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
    // API quirk — Freelo returns the Note body on DELETE; the CLI surfaces it.
    expect(env.data.note?.id).toBe(1234);
  });

  it('single positional --yes (human): "Deleted note #1234." line', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Deleted note #1234\.\s*$/);
  });

  it('multi positional: per-id envelopes', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
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

  it('--ids comma-separated: works', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '--ids',
      '12,13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('--stdin NDJSON: works', async () => {
    server.use(notesHandlers.deleteOk());
    const restore = pipeStdin('{"id": 12}\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
    } finally {
      restore();
    }
  });
});

describe('freelo notes delete — idempotency', () => {
  it('404 → already_in_target_state: true, exit 0; data.note absent (no body to echo)', async () => {
    server.use(notesHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; note?: unknown };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.note).toBeUndefined();
  });

  it('404 (human): "Already deleted: note #1234." line, exit 0', async () => {
    server.use(notesHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '1234',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Already deleted: note #1234\.\s*$/);
  });

  it('isIdempotentDeleteSkip unit test: 404→true, others→false', () => {
    const e404 = new FreeloApiError('not found', 'NOT_FOUND', { httpStatus: 404 });
    const e500 = new FreeloApiError('boom', 'SERVER_ERROR', { httpStatus: 500 });
    expect(isIdempotentDeleteSkip(e404)).toBe(true);
    expect(isIdempotentDeleteSkip(e500)).toBe(false);
  });
});

describe('freelo notes delete — confirmation policy', () => {
  it('non-TTY without --yes: exit 2 CONFIRMATION_REQUIRED', async () => {
    server.use(notesHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['notes', 'delete', '1234', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
  });
});

describe('freelo notes delete — dry-run', () => {
  it('--dry-run: no confirmation prompt, no wire call', async () => {
    // No deleteOk handler; if a DELETE slipped through it would be unhandled.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '1234',
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
    expect(env.data.would.path).toBe('/note/1234');
  });
});

describe('freelo notes delete — stdin batch with malformed line', () => {
  it('json: malformed line emits error envelope with line_index, valid line succeeds', async () => {
    server.use(notesHandlers.deleteOk());
    const restore = pipeStdin('{"id": 12}\nnot-json\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2); // Validation error from malformed line
      const lines = parseAllJsonLines(stdout);
      // Two successes (12, 13) + one error envelope.
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

  it('human: malformed line + valid line: human-mode "Failed item" line, exit 2', async () => {
    server.use(notesHandlers.deleteOk());
    const restore = pipeStdin('{"id": 12}\nnot-json\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('Deleted note #12');
      expect(stdout).toMatch(/Failed item 2/);
    } finally {
      restore();
    }
  });

  it('empty stdin: silent success exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, ['notes', 'delete', '--stdin', '--yes']);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('stdin batch with wire 500: per-line error envelope, exit 4', async () => {
    server.use(notesHandlers.deleteByIdMatrix({ 12: 200, 13: 500 }));
    const restore = pipeStdin('{"id": 12}\n{"id": 13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.notes.delete/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      const errEnv = lines[1] as { error: { context: { line_index: number; note_id: number } } };
      expect(errEnv.error.context.line_index).toBe(1);
      expect(errEnv.error.context.note_id).toBe(13);
    } finally {
      restore();
    }
  });
});

describe('freelo notes delete — multi-id mid-stream failure (json + human)', () => {
  it('json: per-id envelopes; mixed stati, exit code reflects worst', async () => {
    server.use(notesHandlers.deleteByIdMatrix({ 12: 200, 13: 500 }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '12',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4); // 500 → exit 4
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    // first: success
    expect(lines[0]!['schema']).toBe('freelo.notes.delete/v1');
    // second: error
    expect(lines[1]!['schema']).toBe('freelo.error/v1');
    const errEnv = lines[1] as { error: { context: { note_id: number } } };
    expect(errEnv.error.context.note_id).toBe(13);
  });

  it('human: per-id renderer; "Failed item" line for the failure', async () => {
    server.use(notesHandlers.deleteByIdMatrix({ 12: 200, 13: 500 }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'delete',
      '12',
      '13',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toContain('Deleted note #12');
    expect(stdout).toContain('Failed item 2 (note #13)');
  });
});

describe('freelo notes delete — HTTP errors', () => {
  it('401 → exit 3', async () => {
    server.use(notesHandlers.deleteUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '1234', '--yes']);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(notesHandlers.deleteForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '1234', '--yes']);
    expect(exitCode).toBe(4);
  });

  it('5xx → exit 4', async () => {
    server.use(notesHandlers.deleteServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '1234', '--yes']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(notesHandlers.deleteRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '1234', '--yes']);
    expect(exitCode).toBe(6);
  });

  it('network → exit 5', async () => {
    server.use(notesHandlers.deleteNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '1234', '--yes']);
    expect(exitCode).toBe(5);
  });
});

describe('freelo notes delete — validation', () => {
  it('mutex: positional + --ids → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '12', '--ids', '13', '--yes']);
    expect(exitCode).toBe(2);
  });

  it('no source: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', '--yes']);
    expect(exitCode).toBe(2);
  });

  it('non-numeric positional: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'delete', 'abc', '--yes']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo notes delete — introspect', () => {
  it('--introspect: "notes delete" with destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean }> };
    };
    const del = env.data.commands.find((c) => c.name === 'notes delete');
    expect(del).toBeDefined();
    expect(del!.destructive).toBe(true);
  });
});
