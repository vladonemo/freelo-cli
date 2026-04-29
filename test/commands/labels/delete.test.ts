/**
 * End-to-end tests for `freelo labels delete` (R23, spec 0035).
 *
 * GLOBAL hard-delete (decision 10 — confirm copy says "GLOBALLY (across all
 * projects)"). The third destructive command in the CLI (after `tasks
 * delete` and `reports delete`).
 *
 * Covers:
 *   - Happy paths: single positional --yes, multi positional, --ids, --stdin.
 *   - --dry-run skips both confirmation and the wire call.
 *   - **Two-arm idempotency matrix (decision 09):**
 *       1. 404                                 → already_in_target_state: true, exit 0
 *       2. Other non-2xx                       → hard error
 *     Each arm has its own dedicated test (Calibration §4).
 *   - Confirmation policy: non-TTY without --yes → CONFIRMATION_REQUIRED exit 2.
 *   - Validation: bad ids, mutex inputs, missing source.
 *   - HTTP errors: 401 (exit 3), 403 (exit 4), 5xx (exit 4), 429 (exit 6).
 *   - Introspect entry shows destructive: true.
 *   - Direct unit test for `isIdempotentDeleteSkip` matrix.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, projectLabelsHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/labels/delete.js';
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

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-labels-delete-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo labels delete — happy paths', () => {
  it('single positional with --yes: success envelope, exit 0', async () => {
    server.use(projectLabelsHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { label_id: number; current_state: string; already_in_target_state: boolean };
    };
    expect(env.schema).toBe('freelo.labels.delete/v1');
    expect(env.data.label_id).toBe(12);
    expect(env.data.current_state).toBe('deleted');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi positional: per-id envelopes', async () => {
    server.use(projectLabelsHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
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
    expect((lines[0] as { data: { label_id: number } }).data.label_id).toBe(12);
    expect((lines[1] as { data: { label_id: number } }).data.label_id).toBe(13);
  });

  it('--ids comma-separated', async () => {
    server.use(projectLabelsHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '--ids',
      '12,13,14',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
  });

  it('--stdin NDJSON', async () => {
    server.use(projectLabelsHandlers.deleteOk());
    const restore = pipeStdin('{"id":12}\n{"id":13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'labels',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { data: { line_index: number } }).data.line_index).toBe(0);
    } finally {
      restore();
    }
  });

  it('--dry-run skips confirmation prompt and wire call', async () => {
    // No handler registered — would 500 if hit.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('DELETE');
    expect(env.data.would?.path).toBe('/project-labels/12');
  });
});

describe('freelo labels delete — idempotency (decision 09 — two arms)', () => {
  it('arm 1: 404 → already_in_target_state: true, exit 0', async () => {
    server.use(projectLabelsHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 2: 400 (no idempotent fallback) → hard error exit 4', async () => {
    server.use(
      projectLabelsHandlers.deletePerIdRouter({
        '12': () =>
          new Response(JSON.stringify({ errors: ['Some 400 reason.'] }), {
            status: 400,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--yes', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('arm 2: 403 → hard error exit 4', async () => {
    server.use(projectLabelsHandlers.deleteForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--yes', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('mixed batch: one 200 + one 404 idempotent → exit 0, both envelopes emitted', async () => {
    server.use(
      projectLabelsHandlers.deletePerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '13': () =>
          new Response(JSON.stringify({ errors: ['Not found.'] }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
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
    expect(
      (lines[0] as { data: { already_in_target_state: boolean } }).data.already_in_target_state,
    ).toBe(false);
    expect(
      (lines[1] as { data: { already_in_target_state: boolean } }).data.already_in_target_state,
    ).toBe(true);
  });
});

describe('freelo labels delete — confirmation policy', () => {
  it('non-TTY without --yes → ConfirmationError exit 2', async () => {
    // No server handler — confirmation gate fires before any wire call.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('confirmation copy explicitly says "GLOBALLY" in TTY mode', async () => {
    // Switch to TTY mode but mock prompt-decline to assert the message.
    // GitHub Actions sets CI=true, which makes isInteractive() return false
    // regardless of isTTY — temporarily clear it so the TTY-prompt branch runs.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    let captured = '';
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockImplementation((opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(false);
      }),
    }));
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--output', 'json']);
      expect(exitCode).toBe(2);
      expect(captured).toContain('GLOBALLY');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

describe('freelo labels delete — validation', () => {
  it('bad <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '0', '--yes', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('multiple input sources (positional + --ids) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--ids',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one input source|VALIDATION/);
  });

  it('no input sources → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/No label ids supplied|VALIDATION/);
  });
});

describe('freelo labels delete — error paths', () => {
  it('401 → exit 3', async () => {
    server.use(projectLabelsHandlers.deleteUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--yes', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx → exit 4', async () => {
    server.use(projectLabelsHandlers.deleteServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--yes', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(projectLabelsHandlers.deleteRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['labels', 'delete', '12', '--yes', '--output', 'json']);
    expect(exitCode).toBe(6);
  });
});

describe('freelo labels delete — human output', () => {
  it('single delete --output human: prints "Deleted label #12."', async () => {
    server.use(projectLabelsHandlers.deleteOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Deleted label #12.');
  });

  it('404 idempotent --output human: prints "already deleted"', async () => {
    server.use(projectLabelsHandlers.deleteNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already deleted/i);
  });

  it('dry-run --output human: prints "(dry-run) Would delete..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('delete label #12');
  });

  it('batch --output human with one failure: emits human error line for failed item', async () => {
    server.use(
      projectLabelsHandlers.deletePerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '13': () =>
          new Response(JSON.stringify({ errors: ['Server went boom.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '13',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    // first item succeeds (human line)
    expect(stdout).toContain('Deleted label #12.');
    // second item fails (writeBatchError human branch: "Failed item 2 (label #13): ...")
    expect(stdout).toContain('Failed item 2');
    expect(stdout).toContain('label #13');
  });
});

describe('freelo labels delete — writeBatchError envelope shape', () => {
  it('batch --stdin failure with parse error: error envelope has line_index, no label_id', async () => {
    // Send a line with invalid NDJSON shape (missing required "id" field) so
    // parseNdjsonLine returns !ok — hitting the idMaybe===null code path.
    server.use(projectLabelsHandlers.deleteOk());
    const restore = pipeStdin('{"not_id":99}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'labels',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBeGreaterThan(0);
      const env = parseFirstJson(stdout) as {
        schema: string;
        error: { context: Record<string, unknown> };
      };
      expect(env.schema).toBe('freelo.error/v1');
      // fromStdin=true → context carries line_index, NOT input_index
      expect(env.error.context).toHaveProperty('line_index', 0);
      // idMaybe is null so label_id must be absent
      expect(env.error.context).not.toHaveProperty('label_id');
    } finally {
      restore();
    }
  });

  it('batch with 5xx: error envelope carries label_id in context and input_index (not line_index)', async () => {
    server.use(
      projectLabelsHandlers.deletePerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '13': () =>
          new Response(JSON.stringify({ errors: ['Gone.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    // line 0 is the success envelope; line 1 is the error envelope
    const errEnv = lines[1] as { schema: string; error: { context: Record<string, unknown> } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    // fromStdin=false → context carries input_index
    expect(errEnv.error.context).toHaveProperty('input_index', 1);
    // idMaybe is 13 → label_id present
    expect(errEnv.error.context).toHaveProperty('label_id', 13);
  });

  it('toBaseError non-BaseError path: network TypeError is wrapped and emitted as error envelope', async () => {
    // Two-id batch: id 12 succeeds, id 13 gets a network-level error (TypeError).
    // toBaseError catches the non-BaseError and wraps it in a ValidationError so
    // writeBatchError can still emit a structured envelope.
    let callCount = 0;
    server.use(
      http.delete('https://api.freelo.io/v1/project-labels/:labelId', () => {
        callCount++;
        if (callCount === 1) return HttpResponse.json({ result: 'success' });
        return HttpResponse.error(); // causes a TypeError in undici/fetch → not a BaseError
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'delete',
      '12',
      '13',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBeGreaterThan(0);
    const lines = parseAllJsonLines(stdout);
    // First line: success envelope for id 12
    // Second line: error envelope emitted by writeBatchError via toBaseError wrapping
    expect(lines.length).toBeGreaterThanOrEqual(2);
    const errEnv = lines[1] as { schema: string };
    expect(errEnv.schema).toBe('freelo.error/v1');
  });
});

describe('freelo labels delete — introspect', () => {
  it('lists labels delete with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'labels delete');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.labels.delete/v1');
    expect(entry?.destructive).toBe(true);
  });
});

describe('isIdempotentDeleteSkip — heuristic matrix', () => {
  it('arm 1: 404 returns true', () => {
    const err = new FreeloApiError('Not found', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('arm 2: 400 returns false (no documented idempotent fallback)', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', { httpStatus: 400 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 2: 403 returns false', () => {
    const err = new FreeloApiError('Forbidden', 'FORBIDDEN', { httpStatus: 403 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });

  it('arm 2: 500 returns false', () => {
    const err = new FreeloApiError('Server error', 'SERVER_ERROR', { httpStatus: 500 });
    expect(isIdempotentDeleteSkip(err)).toBe(false);
  });
});
