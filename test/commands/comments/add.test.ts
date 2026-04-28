/**
 * End-to-end tests for `freelo comments add` (R17, spec 0028).
 *
 * Covers:
 *   - Happy paths: --message, --from-file, --dry-run.
 *   - Source mutex: zero, two-of-(four).
 *   - --task validation (missing, non-numeric, zero, negative).
 *   - --message empty.
 *   - --from-file ENOENT.
 *   - --editor non-TTY.
 *   - HTTP errors: 401/403/404/422/5xx/429/network (Calibration §2).
 *   - Auto-flip case (`is_description: true` from server).
 *   - Wire body capture.
 *   - Human renderer (regular + flip + dry-run).
 *   - Introspect entry (destructive: false).
 *
 * Direct stdin coverage of the `-` source lives in `test/lib/input.test.ts`
 * (the helper-level test). The integration-layer stdin path goes through
 * the same helper, so the integration tests focus on the four-way mutex,
 * the inline `--message` source, and the file/dry-run/error paths.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, commentsAddHandlers } from '../../msw/handlers.js';

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
    /* swallow; exit captured */
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
    `freelo-comments-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const RESPONSE_OK = {
  id: 7_654_321,
  uuid: 'cmt-uuid-abc',
  content: '<p>Hello world</p>',
  date_add: '2026-04-28T10:00:00Z',
  date_edited_at: '2026-04-28T10:00:00Z',
  is_description: false,
  author: { id: 12_345, fullname: 'Jane Doe' },
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo comments add — happy paths', () => {
  it('--message: exit 0, schema, source="message", byte_length matches', async () => {
    server.use(commentsAddHandlers.addOk(9012, RESPONSE_OK));

    const body = 'Hello — quick question with é unicode.';

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      body,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        source: string;
        byte_length: number;
        is_description: boolean;
        comment: { id: number; content: string };
      };
    };
    expect(env.schema).toBe('freelo.comments.add/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.source).toBe('message');
    expect(env.data.is_description).toBe(false);
    expect(env.data.comment.id).toBe(7_654_321);
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('--from-file: source="file", byte_length matches', async () => {
    const path = join(testDir, 'comment.txt');
    const body = 'Line 1\nLine 2\n';
    await writeFile(path, body, 'utf8');
    server.use(commentsAddHandlers.addOk(9012, RESPONSE_OK));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { source: string; byte_length: number };
    };
    expect(env.data.source).toBe('file');
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('--dry-run: no POST, dry_run=true, would echoes path+body', async () => {
    const body = 'Dry-run body — would post this.';
    // No handler registered — onUnhandledRequest:'error' would trip if a POST happens.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      body,
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run?: boolean;
      data: {
        task_id: number;
        byte_length: number;
        comment?: unknown;
        source?: unknown;
        is_description?: unknown;
        would: { method: string; path: string; body: { content: string } };
      };
    };
    expect(env.schema).toBe('freelo.comments.add/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/9012/comments');
    expect(env.data.would.body.content).toBe(body);
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
    // Live-only fields must be absent in dry-run envelopes.
    expect('comment' in env.data).toBe(false);
    expect('source' in env.data).toBe(false);
    expect('is_description' in env.data).toBe(false);
  });

  it('wire body: { content: <body> } is sent (predicate captures)', async () => {
    const body = 'Body that the predicate captures.';
    let captured: { content?: string } | undefined;
    server.use(
      commentsAddHandlers.addOkWhenBody(
        9012,
        (b) => {
          captured = b as { content?: string };
          return true;
        },
        RESPONSE_OK,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      body,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured!.content).toBe(body);
  });

  it('auto-flip (is_description: true): envelope echoes flag', async () => {
    server.use(commentsAddHandlers.addOkAsDescription(9012, RESPONSE_OK));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'first comment ever',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { is_description: boolean; comment: { is_description?: boolean } };
    };
    expect(env.data.is_description).toBe(true);
    expect(env.data.comment.is_description).toBe(true);
  });

  it('server omits is_description: defaults to false', async () => {
    const responseNoFlag = { ...RESPONSE_OK };
    delete (responseNoFlag as Record<string, unknown>).is_description;
    server.use(commentsAddHandlers.addOk(9012, responseNoFlag));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { is_description: boolean } };
    // Always-present, defaults to false (spec 0028 decision 3).
    expect(env.data.is_description).toBe(false);
  });

  it('human mode: renders "Added comment to task #9012 (X bytes from message)."', async () => {
    server.use(commentsAddHandlers.addOk(9012, RESPONSE_OK));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'short body',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Added comment to task #9012');
    expect(stdout).toContain('bytes from message');
  });

  it('human mode (auto-flip): mentions description and points at `tasks description set`', async () => {
    server.use(commentsAddHandlers.addOkAsDescription(9012, RESPONSE_OK));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'first one',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('first comment');
    expect(stdout).toContain('task description');
    expect(stdout).toContain('tasks description set');
  });

  it('human dry-run: renders "(dry-run) Would POST <path>"', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would POST /task/9012/comments');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo comments add — validation', () => {
  it('missing --task: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('non-numeric --task: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      'abc',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('positive integer');
  });

  it('zero --task: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '0',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('no source flag at all: VALIDATION_ERROR exit 2 with "exactly one"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('exactly one');
  });

  it('--message + --from-file: VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'c.txt');
    await writeFile(path, 'body', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'inline',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--message + - (stdin): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '-',
      '--message',
      'inline',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--from-file + --editor: VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'c.txt');
    await writeFile(path, 'body', 'utf8');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--from-file',
      path,
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--message empty: VALIDATION_ERROR exit 2 with "empty"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('empty');
  });

  it('--from-file with empty content: VALIDATION_ERROR exit 2 with "empty"', async () => {
    const path = join(testDir, 'empty.txt');
    await writeFile(path, '', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('empty');
  });

  it('--from-file ENOENT: VALIDATION_ERROR exit 2 with "not found"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--from-file',
      join(testDir, 'does-not-exist.txt'),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('not found');
  });

  it('--editor in non-TTY: VALIDATION_ERROR exit 2 mentioning "interactive"', async () => {
    // Default in beforeEach: stdin is not a TTY.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('interactive');
  });

  it('unexpected positional (not "-"): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      'something-else',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo comments add — HTTP errors', () => {
  it('401: AUTH_EXPIRED exit 3', async () => {
    server.use(commentsAddHandlers.addUnauthorized(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('403: FORBIDDEN exit 4 with permission hint', async () => {
    server.use(commentsAddHandlers.addForbidden(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
    expect(stderr).toContain('add comments');
  });

  it('404: NOT_FOUND exit 4 with "not found" hint', async () => {
    server.use(commentsAddHandlers.addNotFound(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
  });

  it('422: FREELO_API_ERROR exit 4 (no resource-specific hint rewrite)', async () => {
    server.use(commentsAddHandlers.addUnprocessable(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
    // 404/403 specific hints must NOT fire on a 422.
    expect(stderr).not.toContain('Task 9012 not found');
    expect(stderr).not.toContain('permission to add comments');
  });

  it('5xx: SERVER_ERROR exit 4', async () => {
    server.use(commentsAddHandlers.addServerError(9012, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('429: RATE_LIMITED exit 6', async () => {
    server.use(commentsAddHandlers.addRateLimited(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('network: NETWORK_ERROR exit 5', async () => {
    server.use(commentsAddHandlers.addNetworkError(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'add',
      '--task',
      '9012',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo comments add — introspect', () => {
  it('lists "comments add" with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'comments add');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.comments.add/v1');
    expect(entry?.destructive).toBe(false);
  });
});
