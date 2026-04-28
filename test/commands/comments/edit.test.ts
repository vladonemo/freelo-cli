/**
 * End-to-end tests for `freelo comments edit` (R18, spec 0029).
 *
 * Covers:
 *   - Happy paths: --message, --from-file, --dry-run (single id).
 *   - Batch paths: variadic positional, --ids, --stdin NDJSON, batch dry-run.
 *   - Source mutex (single + batch + stdin).
 *   - Id parsing (missing, non-numeric, zero, negative, --ids empty).
 *   - --message empty, --from-file ENOENT, --from-file empty, --editor non-TTY.
 *   - `-` (stdin sentinel) rejection on multi-id paths (decision 1).
 *   - --stdin + content-source rejection (NDJSON owns content).
 *   - Cross-source mutex (positional + --ids, positional + --stdin, etc.).
 *   - HTTP errors: 401/403/404/422/5xx/429/network (Calibration §2 — every
 *     typed error class triggered, exit-code asserted).
 *   - Mixed-batch error (one success + one failure → highest-of exit code).
 *   - NDJSON malformed line / missing id / empty content.
 *   - Empty stdin → silent success exit 0.
 *   - Wire body capture: { content } only, no `files`.
 *   - Human renderer (regular + dry-run + batch row).
 *   - Introspect entry (destructive: false).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, commentsEditHandlers } from '../../msw/handlers.js';

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

function parseAllJsonLines(text: string): Array<Record<string, unknown>> {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  const out: Array<Record<string, unknown>> = [];
  for (const line of lines) {
    try {
      out.push(JSON.parse(line) as Record<string, unknown>);
    } catch {
      // skip bad
    }
  }
  return out;
}

let testDir: string;
let originalStdin: NodeJS.ReadStream;

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
  originalStdin = process.stdin;
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-comments-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  // Restore stdin in case a test redirected it.
  Object.defineProperty(process, 'stdin', { configurable: true, value: originalStdin });
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

const RESPONSE_OK = {
  id: 1_234_567,
  uuid: 'cmt-uuid-edit',
  content: '<p>Updated content</p>',
  date_add: '2026-04-28T10:00:00Z',
  date_edited_at: '2026-04-28T11:00:00Z',
  is_description: false,
  author: { id: 12_345, fullname: 'Jane Doe' },
};

function responseFor(commentId: number): Record<string, unknown> {
  return { ...RESPONSE_OK, id: commentId };
}

/**
 * Inject a Readable stream as `process.stdin` for an NDJSON test.
 * Must be reset in `afterEach` (see `originalStdin`).
 */
function setStdinTo(text: string): void {
  const stream = Readable.from([text]);
  Object.defineProperty(stream, 'isTTY', { value: false, configurable: true });
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
}

// ---------------------------------------------------------------------------
//  Happy paths — single id
// ---------------------------------------------------------------------------

describe('freelo comments edit — single-id happy paths', () => {
  it('--message: exit 0, schema, source="message", byte_length matches', async () => {
    server.use(commentsEditHandlers.editOk(1_234_567, RESPONSE_OK));

    const body = 'Updated: see PR #42 for the fix.';

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      body,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        comment_id: number;
        source: string;
        byte_length: number;
        comment: { id: number };
      };
    };
    expect(env.schema).toBe('freelo.comments.edit/v1');
    expect(env.data.comment_id).toBe(1_234_567);
    expect(env.data.source).toBe('message');
    expect(env.data.comment.id).toBe(1_234_567);
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('--from-file: source="file", byte_length matches file', async () => {
    const path = join(testDir, 'edit.txt');
    const body = 'Multi\nLine\ncontent.\n';
    await writeFile(path, body, 'utf8');
    server.use(commentsEditHandlers.editOk(1_234_567, RESPONSE_OK));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--from-file',
      path,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { source: string; byte_length: number };
    };
    expect(env.data.source).toBe('file');
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('--dry-run: no POST, dry_run=true, would echoes path+body, comment+source absent', async () => {
    const body = 'Dry-run preview body.';
    // No handler — onUnhandledRequest:'error' would trip if a POST happens.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
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
        comment_id: number;
        byte_length: number;
        comment?: unknown;
        source?: unknown;
        would: { method: string; path: string; body: { content: string } };
      };
    };
    expect(env.schema).toBe('freelo.comments.edit/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.comment_id).toBe(1_234_567);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/comment/1234567');
    expect(env.data.would.body.content).toBe(body);
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
    expect('comment' in env.data).toBe(false);
    expect('source' in env.data).toBe(false);
  });

  it('wire body: { content } only — no `files` field sent', async () => {
    const body = 'Body that the predicate captures.';
    let captured: { content?: string; files?: unknown } | undefined;
    server.use(
      commentsEditHandlers.editOkWhenBody(
        1_234_567,
        (b) => {
          captured = b as { content?: string; files?: unknown };
          return true;
        },
        RESPONSE_OK,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      body,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured!.content).toBe(body);
    expect('files' in (captured as object)).toBe(false);
  });

  it('human mode: renders "Edited comment #1234567 (X bytes from message)."', async () => {
    server.use(commentsEditHandlers.editOk(1_234_567, RESPONSE_OK));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'short body',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Edited comment #1234567');
    expect(stdout).toContain('bytes from message');
  });

  it('human dry-run: renders "(dry-run) Would POST /comment/1234567"', async () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would POST /comment/1234567');
  });
});

// ---------------------------------------------------------------------------
//  Batch happy paths
// ---------------------------------------------------------------------------

describe('freelo comments edit — batch happy paths', () => {
  it('variadic <id>... with --message: 3 envelopes on stdout, all exit 0', async () => {
    server.use(
      commentsEditHandlers.editOk(1_234_567, responseFor(1_234_567)),
      commentsEditHandlers.editOk(1_234_568, responseFor(1_234_568)),
      commentsEditHandlers.editOk(1_234_569, responseFor(1_234_569)),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '1234568',
      '1234569',
      '--message',
      'Closed by sprint review.',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(3);
    const ids = envs.map((e) => (e['data'] as { comment_id: number }).comment_id).sort();
    expect(ids).toEqual([1_234_567, 1_234_568, 1_234_569]);
    for (const e of envs) {
      const data = e['data'] as { source: string };
      expect(data.source).toBe('message');
    }
  });

  it('--ids "1,2,3" with --from-file: 3 envelopes, source="file" each', async () => {
    const path = join(testDir, 'shared.txt');
    const body = 'Shared content across ids.';
    await writeFile(path, body, 'utf8');
    server.use(
      commentsEditHandlers.editOk(1_234_567, responseFor(1_234_567)),
      commentsEditHandlers.editOk(1_234_568, responseFor(1_234_568)),
      commentsEditHandlers.editOk(1_234_569, responseFor(1_234_569)),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '1234567,1234568,1234569',
      '--from-file',
      path,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(3);
    for (const e of envs) {
      const data = e['data'] as { source: string; byte_length: number };
      expect(data.source).toBe('file');
      expect(data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
    }
  });

  it('--stdin NDJSON: 2 envelopes with source="ndjson" and line_index 0/1', async () => {
    const ndjson =
      '{"id":1234567,"content":"Updated: see PR #42 for the fix."}\n' +
      '{"id":1234568,"content":"Reverted; root cause was upstream."}\n';
    setStdinTo(ndjson);
    server.use(
      commentsEditHandlers.editOk(1_234_567, responseFor(1_234_567)),
      commentsEditHandlers.editOk(1_234_568, responseFor(1_234_568)),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
    const first = envs[0]!['data'] as {
      comment_id: number;
      source: string;
      line_index: number;
      byte_length: number;
    };
    const second = envs[1]!['data'] as {
      comment_id: number;
      source: string;
      line_index: number;
      byte_length: number;
    };
    expect(first.comment_id).toBe(1_234_567);
    expect(first.source).toBe('ndjson');
    expect(first.line_index).toBe(0);
    expect(first.byte_length).toBe(Buffer.byteLength('Updated: see PR #42 for the fix.', 'utf8'));
    expect(second.comment_id).toBe(1_234_568);
    expect(second.source).toBe('ndjson');
    expect(second.line_index).toBe(1);
  });

  it('batch dry-run (--ids "1,2" + --message body --dry-run): 2 dry-run envelopes, no POST', async () => {
    // No handlers — onUnhandledRequest:'error' catches any POST regression.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '1234567,1234568',
      '--message',
      'preview',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
    for (const e of envs) {
      expect(e['dry_run']).toBe(true);
      const data = e['data'] as { would: { path: string } };
      expect(data.would.path).toMatch(/^\/comment\/123456[78]$/);
    }
  });

  it('--ids "1": single-id mode (1 envelope; errors would bubble)', async () => {
    server.use(commentsEditHandlers.editOk(1_234_567, RESPONSE_OK));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
//  Validation — id parsing / source mutex
// ---------------------------------------------------------------------------

describe('freelo comments edit — validation (ids)', () => {
  it('no ids at all (missing positional + no --ids/--stdin): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('No comment ids');
  });

  it('non-numeric <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
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

  it('zero <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '0',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('negative --ids value (-5): VALIDATION_ERROR exit 2', async () => {
    // Note: a positional `-5` would be parsed as an unknown short flag by
    // Commander (exit 1). The realistic negative-id path is via `--ids`,
    // which our parser explicitly rejects.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '-5',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--ids "" (empty after trimming): VALIDATION_ERROR exit 2', async () => {
    // Commander treats `--ids ""` as `opts.ids === ''`, which our validator treats as no ids.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '   ',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

describe('freelo comments edit — validation (cross-source mutex)', () => {
  it('positional + --ids: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--ids',
      '1234568',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('exactly one input source');
  });

  it('positional + --stdin: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--stdin',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--ids + --stdin: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--ids',
      '1234567',
      '--stdin',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

describe('freelo comments edit — validation (content sources)', () => {
  it('no content source on single id: VALIDATION_ERROR exit 2 ("exactly one")', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
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
      'edit',
      '1234567',
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

  it('--message + --editor: VALIDATION_ERROR exit 2', async () => {
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'inline',
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it("'-' + --message (single id): VALIDATION_ERROR exit 2", async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '-',
      '--message',
      'inline',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it("'-' with multiple positional ids (decision 1): VALIDATION_ERROR exit 2", async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '1234568',
      '-',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain("'-'");
  });

  it("'-' with no numeric id: VALIDATION_ERROR exit 2", async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['comments', 'edit', '-', '--output', 'json']);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain("'-'");
  });

  it('--stdin + --message: VALIDATION_ERROR exit 2 (NDJSON owns content)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('per-row content');
  });

  it('--stdin + --from-file: VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'c.txt');
    await writeFile(path, 'body', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--message empty (single id): VALIDATION_ERROR exit 2 with "empty"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      '',
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
      'edit',
      '1234567',
      '--from-file',
      join(testDir, 'does-not-exist.txt'),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('not found');
  });

  it('--from-file empty file: VALIDATION_ERROR exit 2 with "empty"', async () => {
    const path = join(testDir, 'empty.txt');
    await writeFile(path, '', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('empty');
  });

  it('--editor in non-TTY: VALIDATION_ERROR exit 2 mentioning "interactive"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('interactive');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (single id) — Calibration §2: every typed error class touched.
// ---------------------------------------------------------------------------

describe('freelo comments edit — HTTP errors (single id)', () => {
  it('401: AUTH_EXPIRED exit 3', async () => {
    server.use(commentsEditHandlers.editUnauthorized(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('403: FORBIDDEN exit 4 with permission hint (defensive — yaml says 404)', async () => {
    server.use(commentsEditHandlers.editForbidden(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
  });

  it('404: NOT_FOUND exit 4 with hint mentioning permission AND missing comment', async () => {
    server.use(commentsEditHandlers.editNotFound(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
    expect(stderr).toContain('permission');
  });

  it('422: FREELO_API_ERROR exit 4 (no resource-specific hint rewrite)', async () => {
    server.use(commentsEditHandlers.editUnprocessable(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
    // Resource-specific 404 hint must not leak onto a 422.
    expect(stderr).not.toContain('Comment 1234567 not found');
  });

  it('5xx: SERVER_ERROR exit 4', async () => {
    server.use(commentsEditHandlers.editServerError(1_234_567, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('429: RATE_LIMITED exit 6', async () => {
    server.use(commentsEditHandlers.editRateLimited(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '--message',
      'body',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('network: NETWORK_ERROR exit 5', async () => {
    server.use(commentsEditHandlers.editNetworkError(1_234_567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
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
//  Batch error mixing — highest-of exit code (Calibration §4 — new try/catch arm).
// ---------------------------------------------------------------------------

describe('freelo comments edit — batch HTTP errors', () => {
  it('mixed positional (200 + 404): exit 4, two stdout envelopes', async () => {
    server.use(
      commentsEditHandlers.editOk(1_234_567, responseFor(1_234_567)),
      commentsEditHandlers.editNotFound(1_234_568),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '1234568',
      '--message',
      'body',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
    const success = envs.find((e) => e['schema'] === 'freelo.comments.edit/v1');
    const errEnv = envs.find((e) => e['schema'] === 'freelo.error/v1');
    expect(success).toBeDefined();
    expect(errEnv).toBeDefined();
    const errPayload = errEnv!['error'] as {
      code: string;
      context: { input_index: number; comment_id: number };
    };
    expect(errPayload.code).toBe('NOT_FOUND');
    expect(errPayload.context.input_index).toBe(1);
    expect(errPayload.context.comment_id).toBe(1_234_568);
  });

  it('mixed batch (401 + 200): exit 3 (highest-of accumulator)', async () => {
    server.use(
      commentsEditHandlers.editUnauthorized(1_234_567),
      commentsEditHandlers.editOk(1_234_568, responseFor(1_234_568)),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '1234568',
      '--message',
      'body',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
  });

  it('mixed batch (404 + 5xx): exit 4 (both map to 4; highest-of stays 4)', async () => {
    server.use(
      commentsEditHandlers.editNotFound(1_234_567),
      commentsEditHandlers.editServerError(1_234_568, 500),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '1234567',
      '1234568',
      '--message',
      'body',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
    expect(envs.every((e) => e['schema'] === 'freelo.error/v1')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  NDJSON parsing edge cases
// ---------------------------------------------------------------------------

describe('freelo comments edit — NDJSON edge cases', () => {
  it('malformed JSON line: per-row freelo.error/v1, exit 2', async () => {
    setStdinTo('not json at all\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
    const errPayload = envs[0]!['error'] as {
      code: string;
      context: { line_index: number };
    };
    expect(errPayload.code).toBe('VALIDATION_ERROR');
    expect(errPayload.context.line_index).toBe(0);
  });

  it('NDJSON missing id: per-row error exit 2', async () => {
    setStdinTo('{"content":"hi"}\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
    const errPayload = envs[0]!['error'] as { code: string };
    expect(errPayload.code).toBe('VALIDATION_ERROR');
  });

  it('NDJSON empty content: per-row error exit 2', async () => {
    setStdinTo('{"id":1234567,"content":""}\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
    const errPayload = envs[0]!['error'] as { code: string };
    expect(errPayload.code).toBe('VALIDATION_ERROR');
  });

  it('NDJSON id: 0 (zero): per-row error exit 2', async () => {
    setStdinTo('{"id":0,"content":"hi"}\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
    const errPayload = envs[0]!['error'] as { code: string };
    expect(errPayload.code).toBe('VALIDATION_ERROR');
  });

  it('NDJSON empty stdin: silent success exit 0', async () => {
    setStdinTo('');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toBe('');
  });

  it('NDJSON with extra keys: per-row error (strict schema)', async () => {
    setStdinTo('{"id":1234567,"content":"hi","oops":1}\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(1);
    const errPayload = envs[0]!['error'] as { code: string };
    expect(errPayload.code).toBe('VALIDATION_ERROR');
  });

  it('mixed NDJSON: row 0 valid + row 1 malformed — one success, one error, exit 2', async () => {
    server.use(commentsEditHandlers.editOk(1_234_567, responseFor(1_234_567)));
    setStdinTo('{"id":1234567,"content":"ok"}\nnot json\n');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'edit',
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const envs = parseAllJsonLines(stdout);
    expect(envs.length).toBe(2);
    const success = envs.find((e) => e['schema'] === 'freelo.comments.edit/v1');
    const errEnv = envs.find((e) => e['schema'] === 'freelo.error/v1');
    expect(success).toBeDefined();
    expect(errEnv).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo comments edit — introspect', () => {
  it('lists "comments edit" with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'comments edit');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.comments.edit/v1');
    expect(entry?.destructive).toBe(false);
  });
});
