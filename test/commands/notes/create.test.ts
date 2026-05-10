/**
 * End-to-end tests for `freelo notes create` (R44, spec 0058).
 *
 * Covers:
 *   - Happy paths: --content inline (json + human), --from-file, name-only (no content).
 *   - --dry-run skips the wire call; would.body matches.
 *   - Validation: missing --project, missing --name, empty --name, empty --content,
 *     unknown positional, multi-source mutex.
 *   - HTTP errors: 400 (exit 2), 401 (exit 3), 403 (exit 4), 404 (exit 4),
 *     429 (exit 6), 5xx (exit 4), network (exit 4).
 *   - Wire body capture (predicate handler).
 *   - Introspect entry (destructive: false).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
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

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-notes-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const PROJECT_ID = 100;

describe('freelo notes create — happy paths', () => {
  it('--request-id threads through to envelope (covers requestId-defined branch)', async () => {
    server.use(notesHandlers.createOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
      '--content',
      'Body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('--content inline (json): exit 0, schema, source=message, byte_length matches', async () => {
    server.use(notesHandlers.createOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      'Body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        project_id: number;
        source: string;
        byte_length: number;
        note: { id: number };
      };
    };
    expect(env.schema).toBe('freelo.notes.create/v1');
    expect(env.data.project_id).toBe(PROJECT_ID);
    expect(env.data.source).toBe('message');
    expect(env.data.byte_length).toBe(Buffer.byteLength('Body', 'utf8'));
    expect(env.data.note.id).toBe(1234);
  });

  it('--content inline (human): renders "Created note ..." line', async () => {
    server.use(notesHandlers.createOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      'Body',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /^Created note "Meeting minutes" in project #100 \(#1234, 4 bytes from message\)\.\s*$/,
    );
  });

  it('name-only (no content flags): source=null, byte_length=0; wire body omits content', async () => {
    let captured: unknown;
    server.use(
      notesHandlers.createOkWhenBody(PROJECT_ID, (body) => {
        captured = body;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['name'] === 'Meeting' &&
          !('content' in (body as Record<string, unknown>))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { source: null | string; byte_length: number } };
    expect(env.data.source).toBe(null);
    expect(env.data.byte_length).toBe(0);
    expect(captured).toEqual({ name: 'Meeting' });
  });

  it("'-' positional (stdin sentinel): reads content from stdin, source=stdin", async () => {
    const { Readable } = await import('node:stream');
    const { Buffer } = await import('node:buffer');
    server.use(notesHandlers.createOk(PROJECT_ID));
    const original = process.stdin;
    const stream = Readable.from([Buffer.from('Body from stdin', 'utf8')]);
    Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'create',
        '-',
        '--project',
        String(PROJECT_ID),
        '--name',
        'Meeting',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const env = parseFirstJson(stdout) as { data: { source: string | null } };
      expect(env.data.source).toBe('stdin');
    } finally {
      Object.defineProperty(process, 'stdin', { configurable: true, value: original });
    }
  });

  it('--from-file: source=file, content read from file', async () => {
    const path = join(testDir, 'note.txt');
    await writeFile(path, 'Body from file', 'utf8');
    server.use(notesHandlers.createOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { source: string; byte_length: number } };
    expect(env.data.source).toBe('file');
    expect(env.data.byte_length).toBe(Buffer.byteLength('Body from file', 'utf8'));
  });

  it('--dry-run: no wire call; would.body matches; envelope has dry_run=true', async () => {
    // No handler — any actual POST would fail with onUnhandledRequest:'error'.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      'Body',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: {
        source: string;
        byte_length: number;
        would: { method: string; path: string; body: { name: string; content: string } };
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/project/${PROJECT_ID}/note`);
    expect(env.data.would.body).toEqual({ name: 'Meeting', content: 'Body' });
  });

  it('--dry-run human: prints "(dry-run) Would POST ..." line', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      'Body',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /^\(dry-run\) Would POST \/project\/100\/note \(4 bytes from message\)\.\s*$/,
    );
  });
});

describe('freelo notes create — validation', () => {
  it('missing --project: exit 2 VALIDATION_ERROR', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--name',
      'Meeting',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing --name: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--name "" (empty after trim): exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--content "" (empty after trim) when source supplied: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('two content sources (--content + --from-file): exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--content',
      'A',
      '--from-file',
      join(testDir, 'nope.txt'),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('unknown positional (not "-"): exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      'banana',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project non-numeric: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'create', '--project', 'abc', '--name', 'X']);
    expect(exitCode).toBe(2);
  });

  it('--editor non-TTY → VALIDATION_ERROR exit 2 (covers hasEditor branch in resolveContent)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'Meeting',
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

describe('freelo notes create — HTTP errors', () => {
  it('400 → exit 4 with hint mentioning --name / --project', async () => {
    server.use(notesHandlers.createBadRequest(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/--name|--project/);
  });

  it('401 → exit 3', async () => {
    server.use(notesHandlers.createUnauthorized(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(notesHandlers.createForbidden(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4', async () => {
    server.use(notesHandlers.createNotFound(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(notesHandlers.createRateLimited(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(6);
  });

  it('500 → exit 4', async () => {
    server.use(notesHandlers.createServerError(PROJECT_ID, 500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network error → exit 5', async () => {
    server.use(notesHandlers.createNetworkError(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'create',
      '--project',
      String(PROJECT_ID),
      '--name',
      'X',
    ]);
    expect(exitCode).toBe(5);
  });
});

describe('freelo notes create — introspect', () => {
  it('--introspect output includes "notes create" with destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          destructive: boolean;
          output_schema: string;
        }>;
      };
    };
    const create = env.data.commands.find((c) => c.name === 'notes create');
    expect(create).toBeDefined();
    expect(create!.destructive).toBe(false);
    expect(create!.output_schema).toBe('freelo.notes.create/v1');
  });
});
