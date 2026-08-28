/**
 * End-to-end tests for `freelo files delete` (M07, spec 0064).
 *
 * Covers:
 *   - Happy paths (single, multi positional, --ids, --stdin) gated behind --yes.
 *   - --dry-run (skips confirmation AND wire call).
 *   - The load-bearing endpoint-specific error surface (spec 0064 §5.1):
 *       404 → a PLAIN not-found error, NOT an idempotent success and NOT a
 *       permission error. This is the divergence from `tasks delete`, so it
 *       gets regression tests that will fail loudly if someone later "restores
 *       consistency" by absorbing the 404.
 *   - The absence of a 400 rewrite (the endpoint documents no 400 — a 500 and
 *     any other status must pass through with their generic message intact).
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad UUIDs, mutex inputs, missing source, NDJSON schema.
 *   - HTTP errors: 401/403/5xx/429/network.
 *   - Batch continue-on-error and exit-code max-of semantics.
 *   - Single-mode envelope has no `line_index` (R11/R13/M01 byte-compat).
 *   - Introspect entry shows `destructive: true`.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class has a triggering test
 * (`ValidationError`, `ConfirmationError`, `FreeloApiError` 401/403/404,
 * `RateLimitedError`, `NetworkError`). Calibration §4: every new try/catch arm
 * (the `rewriteDeleteFileError` 404 branch and its pass-through, the batch
 * per-item catches) has a dedicated row. Calibration §7: TTY-prompt tests clear
 * `process.env.CI`.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, filesDeleteHandlers } from '../../msw/handlers.js';
import { renderFilesDeleteHuman } from '../../../src/ui/human/files-delete.js';

const UUID_A = '3f7c1e2a-9b4d-4c8e-a1f0-6d5b8e2c7a41';
const UUID_B = '8a2b6c04-1e5f-4a9d-b3c7-2f8e0d1a4b56';
const UUID_C = 'c4d5e6f7-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const UUID_MISSING = '00000000-0000-4000-8000-000000000000';

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
    uuid: string;
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
    context?: Record<string, number | string>;
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
    `freelo-files-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Unit: human renderer (both branches, no CLI round-trip needed)
// ---------------------------------------------------------------------------

describe('renderFilesDeleteHuman', () => {
  it('live success says "file or document" — never claims which kind', () => {
    const line = renderFilesDeleteHuman({
      uuid: UUID_A,
      current_state: 'deleted',
      already_in_target_state: false,
    });
    expect(line).toBe(`Deleted file or document ${UUID_A}.`);
  });

  it('dry-run branch is prefixed and uses the conditional mood', () => {
    const line = renderFilesDeleteHuman({
      uuid: UUID_A,
      current_state: 'deleted',
      already_in_target_state: false,
      would: { method: 'DELETE', path: `/file/${UUID_A}`, body: {} },
    });
    expect(line).toBe(`(dry-run) Would delete file or document ${UUID_A}.`);
  });
});

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo files delete — happy paths', () => {
  it('single uuid with --yes: JSON envelope, current_state=deleted, exit 0', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.schema).toBe('freelo.files.delete/v1');
    expect(env.data.uuid).toBe(UUID_A);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('single-uuid envelope carries no line_index (R11/R13/M01 byte-compat)', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['files', 'delete', UUID_A, '--yes', '--output', 'json']);

    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.data).not.toHaveProperty('line_index');
  });

  it('envelope carries rate_limit metadata', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['files', 'delete', UUID_A, '--yes', '--output', 'json']);

    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env).toHaveProperty('rate_limit');
  });

  it('uppercase-hex UUID is accepted and passed through verbatim', async () => {
    const upper = UUID_A.toUpperCase();
    server.use(filesDeleteHandlers.deleteOk(upper));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      upper,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.data.uuid).toBe(upper);
  });

  it('multi positional: one envelope per uuid, in input order, exit 0', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A), filesDeleteHandlers.deleteOk(UUID_B));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as unknown as DeleteEnvelope[];
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => e.data.uuid)).toEqual([UUID_A, UUID_B]);
  });

  it('--ids comma-separated: one envelope per uuid, exit 0', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A), filesDeleteHandlers.deleteOk(UUID_B));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      '--ids',
      `${UUID_A},${UUID_B}`,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as unknown as DeleteEnvelope[];
    expect(envs.map((e) => e.data.uuid)).toEqual([UUID_A, UUID_B]);
  });

  it('--stdin NDJSON: envelopes carry line_index in input order, exit 0', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A), filesDeleteHandlers.deleteOk(UUID_B));
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"${UUID_B}"}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as unknown as DeleteEnvelope[];
      expect(envs.map((e) => e.data.uuid)).toEqual([UUID_A, UUID_B]);
      expect(envs.map((e) => e.data.line_index)).toEqual([0, 1]);
    } finally {
      restore();
    }
  });

  it('human mode prints the "file or document" line, not a JSON envelope', async () => {
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Deleted file or document ${UUID_A}.`);
    expect(stdout).not.toContain('"schema"');
  });
});

// ---------------------------------------------------------------------------
//  --dry-run
// ---------------------------------------------------------------------------

describe('freelo files delete — --dry-run', () => {
  it('makes no wire call and echoes the would-be DELETE (MSW would error on any request)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--dry-run',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('DELETE');
    expect(env.data.would?.path).toBe(`/file/${UUID_A}`);
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('--dry-run without --yes in non-TTY still proceeds (no destructive effect to gate)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as DeleteEnvelope;
    expect(env.dry_run).toBe(true);
  });

  it('--dry-run over --stdin keeps line_index and still makes no wire call', async () => {
    const restore = pipeStdin(`{"uuid":"${UUID_A}"}\n{"uuid":"${UUID_B}"}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--dry-run',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as unknown as DeleteEnvelope[];
      expect(envs.map((e) => e.data.line_index)).toEqual([0, 1]);
      expect(envs.every((e) => e.dry_run === true)).toBe(true);
    } finally {
      restore();
    }
  });

  it('human dry-run copy is prefixed with (dry-run)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(stdout).toContain(`(dry-run) Would delete file or document ${UUID_A}.`);
  });
});

// ---------------------------------------------------------------------------
//  404 — the load-bearing regression rows (spec 0064 §5.1)
//
//  These pin the deliberate divergence from `tasks delete`. If a later refactor
//  "makes the deletes consistent" by absorbing the 404 into an idempotent
//  success, these fail loudly — which is the entire point.
// ---------------------------------------------------------------------------

describe('freelo files delete — 404 is an error, NOT idempotent success', () => {
  it('404 → exit 4, NOT_FOUND, and an error envelope (never already_in_target_state: true)', async () => {
    server.use(filesDeleteHandlers.deleteNotFound(UUID_MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_MISSING,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
    // The anti-refactor pin: no success envelope, no idempotency claim anywhere.
    expect(stdout + stderr).not.toContain('freelo.files.delete/v1');
    expect(stdout + stderr).not.toContain('already_in_target_state');
  });

  it('404 message is a PLAIN not-found — never mentions permission or forbidden', async () => {
    server.use(filesDeleteHandlers.deleteNotFound(UUID_MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'files',
      'delete',
      UUID_MISSING,
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toBe(`File or document ${UUID_MISSING} not found.`);
    expect(env.error.message).not.toMatch(/forbidden|permission|access/i);
  });

  it('the ACL nuance lives in hint_next, and points at `files list`', async () => {
    server.use(filesDeleteHandlers.deleteNotFound(UUID_MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'files',
      'delete',
      UUID_MISSING,
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.hint_next).toMatch(/access/i);
    expect(env.error.hint_next).toContain('freelo files list');
    expect(env.error.retryable).toBe(false);
  });

  it("the server's own errors[] survives the message rewrite", async () => {
    server.use(filesDeleteHandlers.deleteNotFound(UUID_MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr } = await runCli(run, [
      'files',
      'delete',
      UUID_MISSING,
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.errors).toContain('File not found.');
  });

  it('a missing uuid inside an otherwise-good batch fails only that item', async () => {
    server.use(filesDeleteHandlers.deleteMatrix({ [UUID_MISSING]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_MISSING,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJsonLines(stdout);
    expect(envs).toHaveLength(2);
    expect((envs[0] as unknown as DeleteEnvelope).schema).toBe('freelo.files.delete/v1');
    expect((envs[1] as unknown as ErrorEnvelope).error.code).toBe('NOT_FOUND');
  });

  it('the SAME uuid passed twice is NOT de-duplicated — two items in, two envelopes out (§5.4)', async () => {
    // Asserted at the envelope level, deliberately not at the wire level.
    // MSW's node interception in this repo invokes a resolver twice per logical
    // request (reproducible with a bare `fetch(url, {method:'DELETE'})` and no
    // CLI code involved at all), so any assertion on request counts would be
    // measuring the mock, not the command. Two output envelopes carrying
    // input_index 0 and 1 for the same UUID is the real contract: the command
    // processes each input item it was given and collapses nothing.
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as unknown as DeleteEnvelope[];
    expect(envs).toHaveLength(2);
    expect(envs.map((e) => e.data.uuid)).toEqual([UUID_A, UUID_A]);
  });
});

// ---------------------------------------------------------------------------
//  No 400 rewrite — pass-through branch of rewriteDeleteFileError
// ---------------------------------------------------------------------------

describe('freelo files delete — non-404 statuses pass through unrewritten', () => {
  it('500 keeps the generic API-error message (no invented explanation)', async () => {
    server.use(filesDeleteHandlers.deleteServerError(UUID_A, 500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.http_status).toBe(500);
    expect(env.error.retryable).toBe(true);
    expect(env.error.message).not.toContain('not found');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation policy
// ---------------------------------------------------------------------------

describe('freelo files delete — confirmation policy', () => {
  it('non-TTY without --yes → CONFIRMATION_REQUIRED exit 2, zero requests', async () => {
    // No MSW handler registered: onUnhandledRequest: 'error' means any wire
    // call would fail the test independently of the exit-code assertion.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
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
      const { exitCode } = await runCli(run, ['files', 'delete', UUID_A, '--output', 'json']);
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
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['files', 'delete', UUID_A, '--output', 'json']);
      expect(exitCode).toBe(0);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('prompt fires ONCE for an N-uuid run and says "files or documents" plural', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const confirmMock = vi.fn().mockResolvedValue(true);
    vi.doMock('@inquirer/prompts', () => ({ confirm: confirmMock }));
    server.use(
      filesDeleteHandlers.deleteOk(UUID_A),
      filesDeleteHandlers.deleteOk(UUID_B),
      filesDeleteHandlers.deleteOk(UUID_C),
    );

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
        'delete',
        UUID_A,
        UUID_B,
        UUID_C,
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(confirmMock).toHaveBeenCalledTimes(1);
      const arg = confirmMock.mock.calls[0]?.[0] as { message: string };
      expect(arg.message).toBe('Delete 3 files or documents?');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('singular prompt copy for a 1-uuid run', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const confirmMock = vi.fn().mockResolvedValue(true);
    vi.doMock('@inquirer/prompts', () => ({ confirm: confirmMock }));
    server.use(filesDeleteHandlers.deleteOk(UUID_A));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      await runCli(run, ['files', 'delete', UUID_A, '--output', 'json']);
      const arg = confirmMock.mock.calls[0]?.[0] as { message: string };
      expect(arg.message).toBe('Delete 1 file or document?');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('empty --stdin → exit 0, no prompt, no requests', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe('');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation (ValidationError, exit 2)
// ---------------------------------------------------------------------------

describe('freelo files delete — input validation', () => {
  it('malformed positional uuid → exit 2 VALIDATION_ERROR', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      'not-a-uuid',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('<uuid>');
  });

  it('the `-` stdin sentinel is rejected as a malformed uuid (§2.1)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['files', 'delete', '-', '--yes', '--output', 'json']);

    expect(exitCode).toBe(2);
  });

  it('malformed entry inside --ids → exit 2 VALIDATION_ERROR naming --ids', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      '--ids',
      `${UUID_A},nope`,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--ids');
  });

  it('--ids with only separators → exit 2 "requires at least one UUID"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      '--ids',
      ' , , ',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toContain('at least one UUID');
  });

  it('positional + --ids together → exit 2 (mutex)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--ids',
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toContain('exactly one input source');
  });

  it('--ids + --stdin together → exit 2 (mutex)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      '--ids',
      UUID_A,
      '--stdin',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toContain('exactly one input source');
  });

  it('no input source at all → exit 2 "No file UUIDs supplied."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).toBe('No file UUIDs supplied.');
    expect(env.error.hint_next).toContain('freelo files list');
  });
});

// ---------------------------------------------------------------------------
//  NDJSON line-schema validation (per-line errors, continue-on-error)
// ---------------------------------------------------------------------------

describe('freelo files delete — --stdin NDJSON validation', () => {
  it('line missing `uuid` → per-line error with line_index, exit 2', async () => {
    const restore = pipeStdin('{"nope":1}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const env = parseFirstJson(stdout) as ErrorEnvelope;
      expect(env.schema).toBe('freelo.error/v1');
      expect(env.error.context?.['line_index']).toBe(0);
    } finally {
      restore();
    }
  });

  it('line with an extra key is rejected by .strict() → exit 2', async () => {
    const restore = pipeStdin(`{"uuid":"${UUID_A}","extra":true}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
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

  it("line using the sibling commands' `id` key is rejected, not silently ignored", async () => {
    const restore = pipeStdin('{"id":4821993}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
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

  it('line with a malformed uuid value → exit 2, never reaches the wire', async () => {
    const restore = pipeStdin('{"uuid":"nope"}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
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

  it('malformed JSON line → exit 2 with line_index', async () => {
    const restore = pipeStdin('{not json\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const env = parseFirstJson(stdout) as ErrorEnvelope;
      expect(env.error.context?.['line_index']).toBe(0);
    } finally {
      restore();
    }
  });

  it('an all-bad pipe never resolves credentials (no FREELO_API_KEY needed)', async () => {
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    const restore = pipeStdin('{"uuid":"nope"}\n{"bad":1}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      // Exit 2 from the line errors, NOT exit 3 from a missing-credentials
      // ConfigError — proving the lazy client was never built.
      expect(exitCode).toBe(2);
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  HTTP error matrix (calibration §2: one row per typed error class)
// ---------------------------------------------------------------------------

describe('freelo files delete — HTTP error matrix', () => {
  it('401 → exit 3 AUTH_EXPIRED', async () => {
    server.use(filesDeleteHandlers.deleteUnauthorized(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('403 → exit 4 FORBIDDEN', async () => {
    server.use(filesDeleteHandlers.deleteForbidden(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('FORBIDDEN');
  });

  it('429 → RATE_LIMITED', async () => {
    server.use(filesDeleteHandlers.deleteRateLimited(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBeGreaterThan(0);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('network failure → NETWORK_ERROR', async () => {
    server.use(filesDeleteHandlers.deleteNetworkError(UUID_A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBeGreaterThan(0);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Batch semantics: continue-on-error, ordering, context keys, max exit code
// ---------------------------------------------------------------------------

describe('freelo files delete — batch semantics', () => {
  it('positional mixed batch: successes + per-item errors on stdout, input order kept', async () => {
    server.use(filesDeleteHandlers.deleteMatrix({ [UUID_B]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_B,
      UUID_C,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const envs = parseAllJsonLines(stdout);
    expect(envs).toHaveLength(3);
    expect((envs[0] as unknown as DeleteEnvelope).data.uuid).toBe(UUID_A);
    const failed = envs[1] as unknown as ErrorEnvelope;
    expect(failed.schema).toBe('freelo.error/v1');
    expect(failed.error.context?.['input_index']).toBe(1);
    expect(failed.error.context?.['uuid']).toBe(UUID_B);
    expect((envs[2] as unknown as DeleteEnvelope).data.uuid).toBe(UUID_C);
  });

  it('exit code is the max observed across the batch (404 exit 4 beats a 2)', async () => {
    server.use(filesDeleteHandlers.deleteMatrix({ [UUID_B]: 404 }));
    const restore = pipeStdin(`{"bad":1}\n{"uuid":"${UUID_B}"}\n{"uuid":"${UUID_A}"}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'files',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(4);
      const envs = parseAllJsonLines(stdout);
      expect(envs).toHaveLength(3);
      // stdin errors carry line_index, not input_index.
      expect((envs[0] as unknown as ErrorEnvelope).error.context?.['line_index']).toBe(0);
      expect((envs[1] as unknown as ErrorEnvelope).error.context?.['uuid']).toBe(UUID_B);
      expect((envs[2] as unknown as DeleteEnvelope).data.uuid).toBe(UUID_A);
    } finally {
      restore();
    }
  });

  it('human mode batch errors print a "Failed item N (uuid)" line and still exit non-zero', async () => {
    server.use(filesDeleteHandlers.deleteMatrix({ [UUID_B]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain(`Deleted file or document ${UUID_A}.`);
    expect(stdout).toContain(`Failed item 2 (${UUID_B}):`);
  });

  it('a wholly successful batch exits 0', async () => {
    server.use(filesDeleteHandlers.deleteMatrix({}));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'files',
      'delete',
      UUID_A,
      UUID_B,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo files delete — introspect', () => {
  it('shows in --introspect with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const del = env.data.commands.find((c) => c.name === 'files delete');
    expect(del).toBeDefined();
    expect(del?.output_schema).toBe('freelo.files.delete/v1');
    expect(del?.destructive).toBe(true);
  });
});
