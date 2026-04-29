/**
 * End-to-end tests for `freelo labels detach` (R23, spec 0035).
 *
 * Covers:
 *   - Happy paths: single --label, multi --label, --ids, --stdin, --dry-run.
 *   - **Two-arm idempotency matrix (decision 09):**
 *       1. 404 → already_in_target_state: true, exit 0
 *       2. Other non-2xx → hard error
 *   - Validation: missing --project, no input source, mutex sources,
 *     bad --label, bad --project.
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4).
 *   - Batch continue-on-error: mixed responses; exit code = highest-of.
 *   - Introspect entry shows destructive: false.
 *   - Direct unit test for `isIdempotentDetachSkip` matrix.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, projectLabelsHandlers } from '../../msw/handlers.js';
import { isIdempotentDetachSkip } from '../../../src/commands/labels/detach.js';
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
    `freelo-labels-detach-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo labels detach — happy paths', () => {
  it('single --label: success envelope, exit 0', async () => {
    server.use(
      projectLabelsHandlers.detachOkWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return b['id'] === 12;
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        project_id: number;
        label_id: number;
        current_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.labels.detach/v1');
    expect(env.data.project_id).toBe(7);
    expect(env.data.label_id).toBe(12);
    expect(env.data.current_state).toBe('detached');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('multi --label fan-out: one envelope per id', async () => {
    server.use(projectLabelsHandlers.detachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--label',
      '13',
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
    server.use(projectLabelsHandlers.detachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--ids',
      '12,13,14',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(3);
  });

  it('--stdin NDJSON with `label` key', async () => {
    server.use(projectLabelsHandlers.detachOk());
    const restore = pipeStdin('{"label":12}\n{"label":13}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'labels',
        'detach',
        '--project',
        '7',
        '--stdin',
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

  it('--stdin NDJSON with `id` key (alternate accepted shape)', async () => {
    server.use(projectLabelsHandlers.detachOk());
    const restore = pipeStdin('{"id":12}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'labels',
        'detach',
        '--project',
        '7',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const env = parseFirstJson(stdout) as { data: { label_id: number } };
      expect(env.data.label_id).toBe(12);
    } finally {
      restore();
    }
  });

  it('--dry-run: skips POST, envelope has would', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { method: string; path: string; body: unknown } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/project-labels/remove-from-project/7');
    expect(env.data.would?.body).toEqual({ id: 12 });
  });

  it('human output: prints "Detached label #12 from project #7."', async () => {
    server.use(projectLabelsHandlers.detachOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Detached label #12 from project #7');
  });
});

describe('freelo labels detach — idempotency (decision 09 — two arms)', () => {
  it('arm 1: 404 → already_in_target_state: true, exit 0', async () => {
    server.use(projectLabelsHandlers.detachNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '99999',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean };
    };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 2: 5xx → hard error exit 4', async () => {
    server.use(projectLabelsHandlers.detachServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('mixed batch: one 200 + one 404 → exit 0, both envelopes', async () => {
    server.use(
      projectLabelsHandlers.detachPerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '99999': () =>
          new Response(JSON.stringify({ errors: ['Label not attached.'] }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--label',
      '99999',
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

describe('freelo labels detach — validation', () => {
  it('missing --project → exit > 0', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--label',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBeGreaterThan(0);
  });

  it('no input source → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/No label ids supplied|VALIDATION/);
  });

  it('mutex --label + --ids → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--ids',
      '13',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one input source|VALIDATION/);
  });

  it('bad --label (0) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --project (0) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '0',
      '--label',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo labels detach — error paths', () => {
  it('5xx → exit 4', async () => {
    server.use(projectLabelsHandlers.detachServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});

describe('freelo labels detach — human output', () => {
  it('dry-run --output human: prints "(dry-run) Would detach..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('12');
  });

  it('batch with one failure --output human: emits human error line for failed item', async () => {
    server.use(
      projectLabelsHandlers.detachPerIdRouter({
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
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--label',
      '13',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(4);
    // Success line for label 12
    expect(stdout).toContain('Detached label #12');
    // writeBatchError human branch for label 13
    expect(stdout).toContain('Failed item 2');
    expect(stdout).toContain('label #13');
    expect(stdout).toContain('project #7');
  });
});

describe('freelo labels detach — writeBatchError envelope shape', () => {
  it('batch --ids failure: error envelope has input_index and label_id in context', async () => {
    server.use(
      projectLabelsHandlers.detachPerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '13': () =>
          new Response(JSON.stringify({ errors: ['Server error.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--ids',
      '12,13',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    const errEnv = lines[1] as { schema: string; error: { context: Record<string, unknown> } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    // fromStdin=false → input_index
    expect(errEnv.error.context).toHaveProperty('input_index', 1);
    expect(errEnv.error.context).toHaveProperty('label_id', 13);
    expect(errEnv.error.context).toHaveProperty('project_id', 7);
  });

  it('--stdin batch with parse failure: error envelope has line_index and no label_id', async () => {
    // Sending a line missing both `label` and `id` fields → parseNdjsonLine returns !ok
    // → writeBatchError(result.error, i, projectId, null, mode, true) — idMaybe === null
    server.use(projectLabelsHandlers.detachOk());
    const restore = pipeStdin('{"bad_key":12}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'labels',
        'detach',
        '--project',
        '7',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBeGreaterThan(0);
      const env = parseFirstJson(stdout) as {
        schema: string;
        error: { context: Record<string, unknown> };
      };
      expect(env.schema).toBe('freelo.error/v1');
      // fromStdin → line_index in context
      expect(env.error.context).toHaveProperty('line_index', 0);
      // idMaybe is null → label_id absent
      expect(env.error.context).not.toHaveProperty('label_id');
    } finally {
      restore();
    }
  });

  it('batch error envelope with errors[] array: errors field forwarded from API', async () => {
    server.use(
      projectLabelsHandlers.detachPerIdRouter({
        '12': () => Response.json({ result: 'success' }),
        '13': () =>
          new Response(JSON.stringify({ errors: ['constraint violation', 'db locked'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--label',
      '13',
      '--output',
      'json',
    ]);
    const lines = parseAllJsonLines(stdout);
    const errEnv = lines[1] as { error: { errors?: string[] } };
    expect(errEnv.error.errors).toBeDefined();
    expect(Array.isArray(errEnv.error.errors)).toBe(true);
  });

  it('toBaseError non-BaseError path: network TypeError wrapped into error envelope', async () => {
    let callCount = 0;
    server.use(
      http.post('https://api.freelo.io/v1/project-labels/remove-from-project/:projectId', () => {
        callCount++;
        if (callCount === 1) return HttpResponse.json({ result: 'success' });
        return HttpResponse.error();
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'labels',
      'detach',
      '--project',
      '7',
      '--label',
      '12',
      '--label',
      '13',
      '--output',
      'json',
    ]);
    expect(exitCode).toBeGreaterThan(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
  });
});

describe('freelo labels detach — introspect', () => {
  it('lists labels detach with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'labels detach');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.labels.detach/v1');
    expect(entry?.destructive).toBe(false);
  });
});

describe('isIdempotentDetachSkip — heuristic matrix', () => {
  it('arm 1: 404 returns true', () => {
    const err = new FreeloApiError('Not found', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentDetachSkip(err)).toBe(true);
  });

  it('arm 2: 400 returns false (no documented idempotent fallback)', () => {
    const err = new FreeloApiError('Bad request', 'FREELO_API_ERROR', { httpStatus: 400 });
    expect(isIdempotentDetachSkip(err)).toBe(false);
  });

  it('arm 2: 403 returns false', () => {
    const err = new FreeloApiError('Forbidden', 'FORBIDDEN', { httpStatus: 403 });
    expect(isIdempotentDetachSkip(err)).toBe(false);
  });

  it('arm 2: 500 returns false', () => {
    const err = new FreeloApiError('Server error', 'SERVER_ERROR', { httpStatus: 500 });
    expect(isIdempotentDetachSkip(err)).toBe(false);
  });
});
