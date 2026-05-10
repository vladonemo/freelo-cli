/**
 * End-to-end tests for `freelo notes edit` (R44, spec 0058).
 *
 * Covers in particular:
 *   - GET-then-POST flow when only --content is supplied (decision 3).
 *   - Both --output json and --output human happy paths.
 *   - At-least-one-change-flag rule.
 *   - Empty --name / --content rejection.
 *   - 400/403/404/429/5xx/network exit codes.
 *   - Dry-run path with placeholder name.
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
    `freelo-notes-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo notes edit — happy paths', () => {
  it('--request-id threads through to live envelope', async () => {
    server.use(notesHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'edit',
      '1234',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('--request-id threads through dry-run envelope', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'notes',
      'edit',
      '1234',
      '--name',
      'X',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe('aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee');
  });

  it('--name only: single POST with name; applied_changes.name set, content absent', async () => {
    let captured: unknown;
    server.use(
      notesHandlers.editOkWhenBody((body) => {
        captured = body;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['name'] === 'New Title' &&
          !('content' in (body as Record<string, unknown>))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--name',
      'New Title',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        note_id: number;
        applied_changes: { name?: string; content?: string };
        source: string | null;
        byte_length: number;
      };
    };
    expect(env.schema).toBe('freelo.notes.edit/v1');
    expect(env.data.note_id).toBe(1234);
    expect(env.data.applied_changes).toEqual({ name: 'New Title' });
    expect(env.data.source).toBe(null);
    expect(env.data.byte_length).toBe(0);
    expect(captured).toEqual({ name: 'New Title' });
  });

  it('--name + --content: single POST with both; applied_changes has both', async () => {
    server.use(notesHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--name',
      'New',
      '--content',
      'Body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: { name?: string; content?: string }; source: string | null };
    };
    expect(env.data.applied_changes.name).toBe('New');
    expect(env.data.applied_changes.content).toBe('Body');
    expect(env.data.source).toBe('message');
  });

  it('--content only (no --name): GET fetches existing name, then POST sends both', async () => {
    server.use(notesHandlers.showOk()); // GET handler
    let captured: unknown;
    server.use(
      notesHandlers.editOkWhenBody((body) => {
        captured = body;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['name'] === 'Meeting minutes' &&
          (body as Record<string, unknown>)['content'] === 'New body'
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'New body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ name: 'Meeting minutes', content: 'New body' });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: { name?: string; content?: string }; source: string | null };
    };
    // applied_changes echoes user intent (NOT the fetched name).
    expect(env.data.applied_changes).toEqual({ content: 'New body' });
    expect(env.data.source).toBe('message');
  });

  it('--content only: GET 404 surfaces with a useful hint, exit 4 BEFORE any POST', async () => {
    // No editOk handler — if a POST attempt slips through it would 404 unhandled.
    server.use(notesHandlers.showNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'New body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/auto-fetch GET|notes show/);
  });

  it('--content only: GET 403 surfaces with a permission hint, exit 4 BEFORE any POST', async () => {
    server.use(notesHandlers.showForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'New body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/permission to read note/);
  });

  it('--content only: GET 401 bubbles unchanged (rewrite returns err for non-403/404)', async () => {
    server.use(notesHandlers.showUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--content', 'New body']);
    expect(exitCode).toBe(3);
  });

  it('human happy path: prints "Edited note #1234 ..." line', async () => {
    server.use(notesHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--name',
      'New',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Edited note #1234 \(name="New"\)\.\s*$/);
  });

  it("'-' positional (stdin sentinel): reads content from stdin, source=stdin", async () => {
    const { Readable } = await import('node:stream');
    const { Buffer } = await import('node:buffer');
    server.use(notesHandlers.editOk());
    const original = process.stdin;
    const stream = Readable.from([Buffer.from('New body from stdin', 'utf8')]);
    Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notes',
        'edit',
        '1234',
        '-',
        '--name',
        'Title',
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

  it('--from-file: reads content from file, source=file', async () => {
    const { writeFile } = await import('node:fs/promises');
    const path = join(testDir, 'body.txt');
    await writeFile(path, 'File body', 'utf8');
    server.use(notesHandlers.editOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--name',
      'X',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { source: string | null; byte_length: number } };
    expect(env.data.source).toBe('file');
    expect(env.data.byte_length).toBe(Buffer.byteLength('File body', 'utf8'));
  });

  it('--content only: GET returns no name → typed VALIDATION_ERROR exit 2 (defensive)', async () => {
    server.use(notesHandlers.showOk({ id: 1234 })); // body has no `name`
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'Body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--dry-run: skips wire; would.body uses placeholder name when --name is absent', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'New body',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would: { method: string; path: string; body: { name: string; content: string } } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/note/1234');
    expect(env.data.would.body.name).toBe('<existing-name-from-GET>');
    expect(env.data.would.body.content).toBe('New body');
  });
});

describe('freelo notes edit — validation', () => {
  it('no change flags: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234']);
    expect(exitCode).toBe(2);
  });

  it('--name "" (empty after trim): exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', '   ']);
    expect(exitCode).toBe(2);
  });

  it('--content "" (empty after trim): exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--content', '   ']);
    expect(exitCode).toBe(2);
  });

  it('two content sources: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--content',
      'A',
      '--from-file',
      join(testDir, 'nope.txt'),
    ]);
    expect(exitCode).toBe(2);
  });

  it('non-numeric <id>: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', 'abc', '--name', 'X']);
    expect(exitCode).toBe(2);
  });

  it('unknown second positional (not "-"): exit 2 (parseStdinSentinel rejects)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', 'banana', '--name', 'X']);
    expect(exitCode).toBe(2);
  });
});

describe('freelo notes edit — HTTP errors', () => {
  it('400 on edit POST: exit 4', async () => {
    server.use(notesHandlers.editBadRequest());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(4);
  });

  it('403 on edit POST: exit 4', async () => {
    server.use(notesHandlers.editForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(4);
  });

  it('404 on edit POST: exit 4 (NOT idempotent — edit-of-deleted is a real failure)', async () => {
    server.use(notesHandlers.editNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(4);
  });

  it('429: exit 6', async () => {
    server.use(notesHandlers.editRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(6);
  });

  it('500: exit 4', async () => {
    server.use(notesHandlers.editServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(4);
  });

  it('network: exit 5', async () => {
    server.use(notesHandlers.editNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notes', 'edit', '1234', '--name', 'X']);
    expect(exitCode).toBe(5);
  });

  it('human: 404 produces an error envelope (or message) on stderr, exit 4', async () => {
    server.use(notesHandlers.editNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notes',
      'edit',
      '1234',
      '--name',
      'X',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr.length).toBeGreaterThan(0);
  });
});

describe('freelo notes edit — introspect', () => {
  it('--introspect: "notes edit" with destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean; output_schema: string }> };
    };
    const edit = env.data.commands.find((c) => c.name === 'notes edit');
    expect(edit).toBeDefined();
    expect(edit!.destructive).toBe(false);
  });
});
