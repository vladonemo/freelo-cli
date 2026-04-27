/**
 * End-to-end tests for `freelo subtasks add` (R14, spec 0025).
 *
 * Covers:
 *   - Smart-shape response → storage_form='smart', no input_ignored.
 *   - Simple-shape response → storage_form='simple', input_ignored emitted
 *     when user passed --worker / --due.
 *   - --dry-run: no POST, would echoes path + body, no subtask/storage_form.
 *   - Validation: --task / --name / --worker / --due bad values, mutex with
 *     --stdin, etc.
 *   - HTTP errors: 401/403/404/429/5xx/network. Each typed error class
 *     triggered (Calibration §2).
 *   - Batch (--stdin): NDJSON happy path, empty input, all-bad lines, mixed,
 *     per-line `task` rejected, per-line missing/extra keys.
 *   - Introspect entry (destructive: false).
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, subtasksAddHandlers } from '../../msw/handlers.js';

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
    `freelo-subtasks-add-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const SMART_RESPONSE = {
  id: 5001,
  task_id: 9012,
  name: 'My subtask',
  date_add: '2026-04-01T10:00:00Z',
  due_date: '2026-05-01T00:00:00Z',
  worker: { id: 7, fullname: 'Alice' },
  state: { id: 1, state: 'active' },
};

const SIMPLE_RESPONSE = {
  id: 5002,
  task_id: 9012,
  name: 'My checklist row',
  date_add: '2026-04-01T10:00:00Z',
};

// ---------------------------------------------------------------------------
//  Happy paths — single mode
// ---------------------------------------------------------------------------

describe('freelo subtasks add — happy paths (single mode)', () => {
  it('smart-shape response: storage_form=smart, no input_ignored, exit 0', async () => {
    server.use(subtasksAddHandlers.ok(9012, SMART_RESPONSE));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'My subtask',
      '--worker',
      '7',
      '--due',
      '2026-05-01',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        subtask: { id: number };
        storage_form: string;
        input_ignored?: string[];
      };
    };
    expect(env.schema).toBe('freelo.subtasks.add/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.storage_form).toBe('smart');
    expect(env.data.subtask.id).toBe(5001);
    expect('input_ignored' in env.data).toBe(false);
  });

  it('simple-shape response, no extra flags: storage_form=simple, no input_ignored', async () => {
    server.use(subtasksAddHandlers.ok(9012, SIMPLE_RESPONSE));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'My checklist row',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { storage_form: string; input_ignored?: string[] };
    };
    expect(env.data.storage_form).toBe('simple');
    expect('input_ignored' in env.data).toBe(false);
  });

  it('simple-shape response with --worker and --due set: input_ignored=["worker","due"]', async () => {
    server.use(subtasksAddHandlers.ok(9012, SIMPLE_RESPONSE));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--worker',
      '7',
      '--due',
      '2026-05-01',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { storage_form: string; input_ignored: string[] };
    };
    expect(env.data.storage_form).toBe('simple');
    expect(env.data.input_ignored).toEqual(['worker', 'due']);
  });

  it('simple-shape with only --worker set: input_ignored=["worker"]', async () => {
    server.use(subtasksAddHandlers.ok(9012, SIMPLE_RESPONSE));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--worker',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { storage_form: string; input_ignored: string[] };
    };
    expect(env.data.input_ignored).toEqual(['worker']);
  });

  it('--dry-run: no POST, dry_run=true, would echoes path and body', async () => {
    // No handler — onUnhandledRequest:'error' would trip if a POST happens.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'My dry subtask',
      '--worker',
      '7',
      '--due',
      '2026-05-01',
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
        subtask?: unknown;
        storage_form?: string;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.subtasks.add/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/9012/subtasks');
    expect(env.data.would.body['name']).toBe('My dry subtask');
    expect(env.data.would.body['worker']).toBe(7);
    expect(env.data.would.body['due_date']).toBe('2026-05-01T00:00:00Z');
    // dry-run envelope must NOT carry storage_form or subtask.
    expect('subtask' in env.data).toBe(false);
    expect('storage_form' in env.data).toBe(false);
  });

  it('human mode (smart): renders Created subtask line', async () => {
    server.use(subtasksAddHandlers.ok(9012, SMART_RESPONSE));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'My subtask',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created subtask #5001');
    expect(stdout).toContain('"My subtask"');
  });

  it('human mode (simple with discarded): renders fallback note', async () => {
    server.use(subtasksAddHandlers.ok(9012, SIMPLE_RESPONSE));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--worker',
      '7',
      '--due',
      '2026-05-01',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('simple taskcheck');
    expect(stdout).toContain('ignored: worker, due');
  });

  it('wire body: --due is mapped to <date>T00:00:00Z and --worker passes through', async () => {
    let captured: Record<string, unknown> | undefined;
    server.use(
      subtasksAddHandlers.okWhenBody(
        9012,
        (body) => {
          captured = body as Record<string, unknown>;
          return true;
        },
        SMART_RESPONSE,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--worker',
      '11',
      '--due',
      '2026-06-15',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured!['name']).toBe('X');
    expect(captured!['worker']).toBe(11);
    expect(captured!['due_date']).toBe('2026-06-15T00:00:00Z');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo subtasks add — validation', () => {
  it('missing --task: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['subtasks', 'add', '--name', 'X', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('missing --name (single mode): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('--name');
  });

  it('--name empty string: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--worker non-positive: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--worker',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--due invalid format: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--due',
      'tomorrow',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--name + --stdin: VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin(`${JSON.stringify({ name: 'X' })}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--name',
        'X',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('VALIDATION_ERROR');
      expect(stderr).toContain('--name');
    } finally {
      restore();
    }
  });

  it('--worker + --stdin: VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin(`${JSON.stringify({ name: 'X' })}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--worker',
        '7',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });

  it('--due + --stdin: VALIDATION_ERROR exit 2', async () => {
    const restore = pipeStdin(`${JSON.stringify({ name: 'X' })}\n`);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--due',
        '2026-05-01',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(stderr).toContain('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2 — every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo subtasks add — HTTP errors', () => {
  it('POST 401: AUTH_EXPIRED, exit 3', async () => {
    server.use(subtasksAddHandlers.unauthorized(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('POST 403: FORBIDDEN, exit 4, hint mentions permission', async () => {
    server.use(subtasksAddHandlers.forbidden(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
  });

  it('POST 404: NOT_FOUND, exit 4, hint mentions task not found', async () => {
    server.use(subtasksAddHandlers.notFound(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
  });

  it('POST 5xx: SERVER_ERROR, exit 4', async () => {
    server.use(subtasksAddHandlers.serverError(9012, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('POST 429: RATE_LIMITED, exit 6', async () => {
    server.use(subtasksAddHandlers.rateLimited(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('POST network failure: NETWORK_ERROR, exit 5', async () => {
    server.use(subtasksAddHandlers.networkError(9012));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });

  it('POST 422 (non-404/403): hint NOT rewritten (passes through unchanged)', async () => {
    // Spec 0025 §4.5 / decision 17: rewriteAddHint only fires on 404/403.
    // This locks the "non-404/403 passes through" branch.
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.post(`https://api.freelo.io/v1/task/9012/subtasks`, () =>
        HttpResponse.json({ errors: ['Validation failed.'] }, { status: 422 }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'subtasks',
      'add',
      '--task',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    // 422 maps to FreeloApiError 'FREELO_API_ERROR' exit 4 (per
    // freelo-api-error.ts mapping).
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
    // The hint should NOT mention "permission" (the 403 hint) nor "Task X not
    // found" (the 404 hint) — it just propagates the upstream rendering.
    expect(stderr).not.toContain('permission to add subtasks');
  });
});

// ---------------------------------------------------------------------------
//  Batch (--stdin) mode
// ---------------------------------------------------------------------------

describe('freelo subtasks add --stdin — happy paths', () => {
  it('two valid lines: 2 success envelopes with line_index, exit 0', async () => {
    // Single handler responds to every POST in this batch (mirrors the
    // `tasks create --stdin` test pattern).
    server.use(subtasksAddHandlers.ok(9012, SMART_RESPONSE));
    const ndjson =
      `${JSON.stringify({ name: 'A', worker: 7 })}\n` + `${JSON.stringify({ name: 'B' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      for (let i = 0; i < 2; i += 1) {
        expect(lines[i]!['schema']).toBe('freelo.subtasks.add/v1');
        const data = lines[i]!['data'] as { line_index: number };
        expect(data.line_index).toBe(i);
      }
    } finally {
      restore();
    }
  });

  it('empty stdin: silent success exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('all-bad lines (malformed JSON): per-line error envelopes, exit 2', async () => {
    const restore = pipeStdin('not json\nstill not json\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      for (let i = 0; i < 2; i += 1) {
        expect(lines[i]!['schema']).toBe('freelo.error/v1');
        const err = lines[i]!['error'] as { code: string; context: { line_index: number } };
        expect(err.code).toBe('VALIDATION_ERROR');
        expect(err.context.line_index).toBe(i);
      }
    } finally {
      restore();
    }
  });

  it('mixed valid + bad-JSON: 1 success + 1 error, exit 2', async () => {
    server.use(subtasksAddHandlers.ok(9012, { ...SMART_RESPONSE, id: 6001 }));
    const ndjson = `${JSON.stringify({ name: 'A' })}\nnot-json\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.subtasks.add/v1');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('per-line `task` key: VALIDATION_ERROR per-line, exit 2', async () => {
    const ndjson = `${JSON.stringify({ name: 'A', task: 9012 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      const err = lines[0]!['error'] as { code: string; message: string };
      expect(err.code).toBe('VALIDATION_ERROR');
      expect(err.message).toContain('task');
    } finally {
      restore();
    }
  });

  it('per-line missing `name`: VALIDATION_ERROR per-line, exit 2', async () => {
    const ndjson = `${JSON.stringify({ worker: 7 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('per-line extra unknown key: VALIDATION_ERROR per-line (zod strict), exit 2', async () => {
    const ndjson = `${JSON.stringify({ name: 'A', priority: 'high' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('--stdin: HTTP error mid-batch propagates as per-line error envelope, exit max', async () => {
    // 401 mid-batch → exit 3 (auth-expired wins over earlier success exit 0).
    // Exercises the per-line FreeloApiError catch arm in runBatch
    // (Calibration §4 — new try/catch arms must have a triggering test).
    server.use(subtasksAddHandlers.unauthorized(9012));
    const ndjson = `${JSON.stringify({ name: 'A' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(3);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      const err = lines[0]!['error'] as { code: string; context: { line_index: number } };
      expect(err.code).toBe('AUTH_EXPIRED');
      expect(err.context.line_index).toBe(0);
    } finally {
      restore();
    }
  });

  it('--stdin --dry-run: per-line dry envelopes, no POST, exit 0', async () => {
    const ndjson =
      `${JSON.stringify({ name: 'A' })}\n` +
      `${JSON.stringify({ name: 'B', due: '2026-05-01' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'subtasks',
        'add',
        '--task',
        '9012',
        '--stdin',
        '--dry-run',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      for (let i = 0; i < 2; i += 1) {
        expect(lines[i]!['dry_run']).toBe(true);
        const data = lines[i]!['data'] as { would: { path: string }; line_index: number };
        expect(data.would.path).toBe('/task/9012/subtasks');
        expect(data.line_index).toBe(i);
      }
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo subtasks add — introspect', () => {
  it('lists subtasks add with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'subtasks add');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.subtasks.add/v1');
    expect(entry?.destructive).toBe(false);
  });
});
