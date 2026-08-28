/**
 * End-to-end tests for `freelo comments delete` (M01, spec 0061).
 *
 * Covers:
 *   - Happy paths (single, multi positional, --ids, --stdin) gated behind --yes.
 *   - --dry-run (skips confirmation AND wire call).
 *   - The two load-bearing endpoint-specific error surfaces:
 *       * 400 → the 15-minute deletion window, rewritten to a specific
 *         message + a hint pointing at `comments edit` (spec 0061 §5.2).
 *       * 404 → a PLAIN not-found error, NOT an idempotent success and NOT a
 *         permission error (spec 0061 §5.1 / decision 1). This is the
 *         divergence from `tasks delete`, so it gets regression tests that
 *         will fail loudly if someone later "restores consistency".
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad ids, mutex inputs, missing source, NDJSON schema.
 *   - HTTP errors: 401/403/5xx/429/network.
 *   - Batch continue-on-error and exit-code max-of semantics.
 *   - Single-mode envelope has no `line_index` (R11/R13 byte-compat).
 *   - Introspect entry shows `destructive: true`.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class has a triggering test
 * (`ValidationError`, `ConfirmationError`, `FreeloApiError` 400/401/403/404,
 * `RateLimitedError`, `NetworkError`). Calibration §4: every new try/catch arm
 * (the `rewriteDeleteCommentError` branches, the batch per-id catches) has a
 * dedicated row. Calibration §7: TTY-prompt tests clear `process.env.CI`.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, commentsDeleteHandlers } from '../../msw/handlers.js';

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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stream,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: original,
    });
  };
}

type DeleteEnvelope = {
  schema: string;
  dry_run?: boolean;
  data: {
    comment_id: number;
    current_state: string;
    already_in_target_state: boolean;
    would?: { method: string; path: string };
    line_index?: number;
  };
  rate_limit?: { remaining: number | null; reset_at: string | null };
};

type ErrorEnvelope = {
  schema: string;
  error: {
    code: string;
    message: string;
    errors?: string[];
    http_status: number | null;
    retryable: boolean;
    hint_next: string | null;
    context?: Record<string, number>;
  };
};

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
    `freelo-comments-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  // Default: non-TTY (agent path). Tests that need TTY mock it explicitly.
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

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo comments delete — happy paths', () => {
  it('single id with --yes: JSON envelope, current_state=deleted, exit 0', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.schema).toBe('freelo.comments.delete/v1');
    expect(env.data.comment_id).toBe(4821993);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('single-id envelope carries no line_index (R11/R13 byte-compat)', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.data).not.toHaveProperty('line_index');
  });

  it('envelope carries rate_limit metadata', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env).toHaveProperty('rate_limit');
  });

  it('multi positional with --yes: two success envelopes in input order', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993), commentsDeleteHandlers.deleteOk(4821994));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '4821994',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as DeleteEnvelope[];
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => e.data.comment_id)).toEqual([4821993, 4821994]);
  });

  it('--ids "a,b" with --yes: two success envelopes', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993), commentsDeleteHandlers.deleteOk(4821994));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '--ids',
      '4821993,4821994',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as DeleteEnvelope[];
    expect(envs.map((e) => e.data.comment_id)).toEqual([4821993, 4821994]);
  });

  it('--stdin NDJSON with --yes: envelopes carry line_index 0,1', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993), commentsDeleteHandlers.deleteOk(4821994));
    const restore = pipeStdin('{"id":4821993}\n{"id":4821994}\n');

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as DeleteEnvelope[];
      expect(envs).toHaveLength(2);
      expect(envs[0]?.data.line_index).toBe(0);
      expect(envs[1]?.data.line_index).toBe(1);
    } finally {
      restore();
    }
  });

  it('human mode renders the Deleted line', async () => {
    server.use(commentsDeleteHandlers.deleteOk(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Deleted comment #4821993.');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo comments delete — dry-run', () => {
  it('--dry-run without --yes in non-TTY: exit 0, would echoed, zero requests', async () => {
    // No handler registered and `onUnhandledRequest: 'error'` is set, so any
    // wire call would fail the test.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('DELETE');
    expect(env.data.would?.path).toBe('/comment/4821993');
  });

  it('--dry-run human mode renders the would-delete line', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would delete comment #4821993.');
  });

  it('--dry-run over --stdin: no wire calls, line_index preserved', async () => {
    const restore = pipeStdin('{"id":4821993}\n{"id":4821994}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--dry-run',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as DeleteEnvelope[];
      expect(envs).toHaveLength(2);
      expect(envs[1]?.data.line_index).toBe(1);
      expect(envs[1]?.dry_run).toBe(true);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  The 15-minute deletion window (400) — spec 0061 §5.2
// ---------------------------------------------------------------------------

describe('freelo comments delete — 15-minute deletion window (400)', () => {
  it('400 → exit 4, FREELO_API_ERROR, message names the 15-minute window', async () => {
    server.use(commentsDeleteHandlers.deleteWindowExpired(4700001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4700001',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.http_status).toBe(400);
    expect(env.error.retryable).toBe(false);
    expect(env.error.message).toContain('15-minute');
    expect(env.error.message).toContain('4700001');
    // Explicitly NOT the generic passthrough.
    expect(env.error.message).not.toBe('Freelo API error (HTTP 400).');
  });

  it('400 hint points at `comments edit` as the workaround', async () => {
    server.use(commentsDeleteHandlers.deleteWindowExpired(4700001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'comments',
      'delete',
      '4700001',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.hint_next).toContain('comments edit');
    expect(env.error.hint_next).toContain('no time limit');
  });

  it("400 preserves the server's own errors[] so a future second 400 cause stays visible", async () => {
    server.use(commentsDeleteHandlers.deleteWindowExpired(4700001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'comments',
      'delete',
      '4700001',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.errors).toContain('Comment is too old to be deleted.');
  });
});

// ---------------------------------------------------------------------------
//  404 is an ERROR, not idempotent success — spec 0061 §5.1 / decision 1
//
//  These are the regression tests that pin the divergence from `tasks delete`.
//  If someone later "restores consistency" by re-adding a 404-absorbing catch
//  arm, these fail.
// ---------------------------------------------------------------------------

describe('freelo comments delete — 404 is an error, not idempotent success', () => {
  it('404 → exit 4 with NOT_FOUND, NOT exit 0', async () => {
    server.use(commentsDeleteHandlers.deleteNotFound(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('404 emits NO success envelope on stdout (never already_in_target_state: true)', async () => {
    server.use(commentsDeleteHandlers.deleteNotFound(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(stdout).not.toContain('freelo.comments.delete/v1');
    expect(stdout).not.toContain('already_in_target_state');
  });

  it('404 message is a PLAIN not-found — never a permission error', async () => {
    server.use(commentsDeleteHandlers.deleteNotFound(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toBe('Comment 4821993 not found.');
    expect(env.error.message.toLowerCase()).not.toContain('forbidden');
    expect(env.error.message.toLowerCase()).not.toContain('permission');
    expect(env.error.message).not.toContain('403');
  });

  it('404 hint explains the ACL-hides-existence nuance', async () => {
    server.use(commentsDeleteHandlers.deleteNotFound(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.hint_next).toContain('author');
    expect(env.error.hint_next).toContain('404');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo comments delete — confirmation', () => {
  it('non-TTY without --yes → CONFIRMATION_REQUIRED exit 2, zero requests', async () => {
    // No handler registered: any wire call errors out under
    // `onUnhandledRequest: 'error'`.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('TTY + user declines → exit 2, zero requests', async () => {
    // Calibration §7: GitHub Actions sets CI=true, which makes isInteractive()
    // return false regardless of isTTY — clear it so the prompt branch runs.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(false),
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['comments', 'delete', '4821993', '--output', 'json']);
      expect(exitCode).toBe(2);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY + user accepts → proceeds, exit 0', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(true),
    }));
    server.use(commentsDeleteHandlers.deleteOk(4821993));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['comments', 'delete', '4821993', '--output', 'json']);
      expect(exitCode).toBe(0);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('confirmation prompt fires ONCE for an N-id run, and says "comments" plural', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const confirmMock = vi.fn().mockResolvedValue(true);
    vi.doMock('@inquirer/prompts', () => ({ confirm: confirmMock }));
    server.use(
      commentsDeleteHandlers.deleteOk(4821993),
      commentsDeleteHandlers.deleteOk(4821994),
      commentsDeleteHandlers.deleteOk(4821995),
    );

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'comments',
        'delete',
        '4821993',
        '4821994',
        '4821995',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      const arg = confirmMock.mock.calls[0]?.[0] as { message: string };
      expect(arg.message).toBe('Delete 3 comments?');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('empty --stdin → exit 0, no prompt, no requests', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--output',
        'json',
      ]);
      // No --yes, yet exit 0: confirmation is never reached because stdin
      // buffered to zero lines (spec 0061 §2.3).
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Remaining typed-error coverage (calibration §2)
// ---------------------------------------------------------------------------

describe('freelo comments delete — HTTP error paths', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(commentsDeleteHandlers.deleteUnauthorized(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('403 → FORBIDDEN exit 4 (defensive; yaml says ACL failures are 404)', async () => {
    server.use(commentsDeleteHandlers.deleteForbidden(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('FORBIDDEN');
  });

  it('500 → SERVER_ERROR exit 4, retryable true', async () => {
    server.use(commentsDeleteHandlers.deleteServerError(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.retryable).toBe(true);
  });

  // Exit 6, not 5: `RateLimitedError.exitCode = 6`
  // (`src/errors/rate-limited-error.ts` :16). Exit 5 is `NetworkError`.
  it('429 past the retry budget → RATE_LIMITED exit 6', async () => {
    server.use(commentsDeleteHandlers.deleteRateLimited(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('network failure → NETWORK_ERROR exit 5', async () => {
    server.use(commentsDeleteHandlers.deleteNetworkError(4821993));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Validation (all exit 2)
// ---------------------------------------------------------------------------

describe('freelo comments delete — validation', () => {
  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      'abc',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('<id> of 0 → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it("the '-' stdin sentinel is not an id here → ValidationError exit 2", async () => {
    // `comments edit` accepts `-` as "read content from stdin"; delete has no
    // content, so `-` must not be silently accepted (spec 0061 §2.1).
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      '-',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('no input sources → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/No comment ids supplied|VALIDATION/);
  });

  it('positional + --ids together → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--ids',
      '4821994',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one input source|VALIDATION/);
  });

  it('--stdin + positional together → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--ids with only separators → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      '--ids',
      ' , , ',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('NDJSON row with an extra key → per-line VALIDATION_ERROR, exit 2', async () => {
    const restore = pipeStdin('{"id":4821993,"oops":true}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stdout) as ErrorEnvelope;
      expect(env.schema).toBe('freelo.error/v1');
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.context?.['line_index']).toBe(0);
    } finally {
      restore();
    }
  });

  it('NDJSON row with a string id → per-line VALIDATION_ERROR, exit 2', async () => {
    const restore = pipeStdin('{"id":"4821993"}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Batch semantics — continue-on-error, max-of exit code
// ---------------------------------------------------------------------------

describe('freelo comments delete — batch semantics', () => {
  it('mixed positional batch (ok, 404, ok): both successes emitted, exit 4', async () => {
    server.use(commentsDeleteHandlers.deleteMatrix({ 4821994: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '4821994',
      '4821995',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    const successes = lines.filter((l) => l['schema'] === 'freelo.comments.delete/v1');
    const errors = lines.filter((l) => l['schema'] === 'freelo.error/v1');
    // Continue-on-error: the 404 in the middle did not abort the run.
    expect(successes).toHaveLength(2);
    expect(errors).toHaveLength(1);
    const err = errors[0] as unknown as ErrorEnvelope;
    expect(err.error.code).toBe('NOT_FOUND');
    expect(err.error.context?.['input_index']).toBe(1);
    expect(err.error.context?.['comment_id']).toBe(4821994);
  });

  it('mixed --stdin batch: error envelope carries line_index', async () => {
    server.use(commentsDeleteHandlers.deleteMatrix({ 4821994: 400 }));
    const restore = pipeStdin('{"id":4821993}\n{"id":4821994}\n');

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'comments',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      const errors = lines.filter((l) => l['schema'] === 'freelo.error/v1');
      expect(errors).toHaveLength(1);
      const err = errors[0] as unknown as ErrorEnvelope;
      expect(err.error.context?.['line_index']).toBe(1);
      expect(err.error.context?.['comment_id']).toBe(4821994);
      // The 400 rewrite applies in batch mode too.
      expect(err.error.message).toContain('15-minute');
    } finally {
      restore();
    }
  });

  it('max-of exit code: a 401 (exit 3) and a 404 (exit 4) in one batch → exit 4', async () => {
    server.use(commentsDeleteHandlers.deleteMatrix({ 4821993: 401, 4821994: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '4821994',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
  });

  it('batch human mode renders a Failed item line per failure', async () => {
    server.use(commentsDeleteHandlers.deleteMatrix({ 4821994: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'comments',
      'delete',
      '4821993',
      '4821994',
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain('Deleted comment #4821993.');
    expect(stdout).toContain('Failed item 2 (comment #4821994)');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo comments delete — introspect', () => {
  it('shows in --introspect with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const del = env.data.commands.find((c) => c.name === 'comments delete');
    expect(del).toBeDefined();
    expect(del?.output_schema).toBe('freelo.comments.delete/v1');
    expect(del?.destructive).toBe(true);
  });
});
