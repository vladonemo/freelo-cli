/**
 * End-to-end tests for `freelo custom-fields value clear` (R42, spec 0055).
 *
 * Read-then-delete flow:
 *   1. GET /task/{id} → find custom_fields[].field_uuid → value_uuid
 *   2. If no value_uuid → idempotent skip (already_in_target_state: true)
 *   3. Else DELETE /custom-field/delete-value/{value_uuid}
 *      On 404 → idempotent skip (race condition)
 *
 * Covers:
 *   - Happy: read-back finds a value → DELETE → success.
 *   - Idempotent arm 1: read-back finds nothing → no DELETE issued.
 *   - Idempotent arm 2: DELETE 404 → already_in_target_state: true.
 *   - Other arms: 403 on read-back, 403 on DELETE, 5xx, 401.
 *   - Validation: missing flags, bad task, bad field, mutex flag + --stdin.
 *   - Confirmation: non-TTY without --yes → exit 2; TTY prompt copy contains "value".
 *   - --dry-run: no read-back, no DELETE; envelope carries placeholder path.
 *   - Batch via --stdin: per-line success / mixed outcomes.
 *   - Human output paths.
 *   - Direct unit test for `isIdempotentDeleteSkip` matrix.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, customFieldsValueHandlers } from '../../msw/handlers.js';
import { isIdempotentDeleteSkip } from '../../../src/commands/custom-fields/value/clear.js';
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
      /* try next */
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

const FIELD_UUID = '11111111-1111-1111-1111-111111111111';
const OTHER_FIELD = '22222222-2222-2222-2222-222222222222';
const VALUE_UUID = 'cfv-1111-2222-3333';

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
    `freelo-cf-value-clear-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo custom-fields value clear — happy paths', () => {
  it('read-back finds a value, DELETE 200 → success envelope', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: VALUE_UUID, value: 'old' },
      ]),
      customFieldsValueHandlers.deleteOk(),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task_id: number;
        value_uuid: string | null;
        previous_state: string;
        already_in_target_state: boolean;
      };
    };
    expect(env.schema).toBe('freelo.custom-fields.value-clear/v1');
    expect(env.data.task_id).toBe(7);
    expect(env.data.value_uuid).toBe(VALUE_UUID);
    expect(env.data.previous_state).toBe('set');
    expect(env.data.already_in_target_state).toBe(false);
  });

  it('--dry-run: no wire calls, would.path uses placeholder', async () => {
    // No handlers — would 500 if hit.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
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
    expect(env.data.would?.path).toContain('/custom-field/delete-value/');
    expect(env.data.would?.path).toContain('would-be-resolved');
  });
});

describe('freelo custom-fields value clear — idempotency (two arms)', () => {
  it('arm 1: read-back finds no entry for the field → already_in_target_state: true, exit 0, no DELETE', async () => {
    // Only the GET handler — no DELETE handler. If DELETE was attempted it would 500.
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: OTHER_FIELD, value_uuid: 'other-value' },
      ]),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        previous_state: string;
        already_in_target_state: boolean;
        value_uuid: string | null;
      };
    };
    expect(env.data.previous_state).toBe('absent');
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.value_uuid).toBeNull();
  });

  it('arm 1: read-back returns entry with no value_uuid → already_in_target_state: true', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: null },
      ]),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { already_in_target_state: boolean } };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 1: read-back returns custom_fields not-an-array (empty/null) → already_in_target_state: true', async () => {
    server.use(customFieldsValueHandlers.getTaskWithCustomFields(7, []));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { already_in_target_state: boolean } };
    expect(env.data.already_in_target_state).toBe(true);
  });

  it('arm 2: read-back finds a value but DELETE returns 404 → already_in_target_state: true', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: VALUE_UUID },
      ]),
      customFieldsValueHandlers.deleteNotFound(),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { already_in_target_state: boolean; previous_state: string };
    };
    expect(env.data.already_in_target_state).toBe(true);
    expect(env.data.previous_state).toBe('set');
  });
});

describe('freelo custom-fields value clear — error mapping', () => {
  it('read-back 404 (task not found) → exit 4 with task-not-found hint', async () => {
    server.use(customFieldsValueHandlers.getTaskNotFound(7));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/task not found/i);
  });

  it('read-back 403 → exit 4 with read-back-permission hint', async () => {
    server.use(
      http.get('https://api.freelo.io/v1/task/7', () =>
        HttpResponse.json({ errors: ['Role action forbidden.'] }, { status: 403 }),
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/read-back required/i);
  });

  it('DELETE 403 → exit 4 with edit-permission hint', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: VALUE_UUID },
      ]),
      customFieldsValueHandlers.deleteForbidden(),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/cannot edit custom-field values/i);
  });

  it('DELETE 5xx → exit 4', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: VALUE_UUID },
      ]),
      customFieldsValueHandlers.deleteServerError(500),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('read-back 401 → exit 3', async () => {
    server.use(
      http.get('https://api.freelo.io/v1/task/7', () =>
        HttpResponse.json({ errors: ['Invalid token.'] }, { status: 401 }),
      ),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });
});

describe('freelo custom-fields value clear — validation', () => {
  it('missing --task → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('missing --field → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --task (negative) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '-1',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --field (whitespace) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      '   ',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('flag input + --stdin → ValidationError exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--task',
        '7',
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

  it('no input source → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields value clear — confirmation policy', () => {
  it('non-TTY without --yes → ConfirmationError exit 2', async () => {
    // No handlers — confirmation gate fires before any wire call.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('confirmation copy mentions "value" in TTY mode', async () => {
    // Calibration §7: TTY-prompt code paths must clear CI to short-circuit isInteractive().
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
      const { exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--task',
        '7',
        '--field',
        FIELD_UUID,
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(captured).toMatch(/value/i);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

describe('freelo custom-fields value clear — batch via --stdin', () => {
  it('two lines, both succeed (one with value, one already-absent)', async () => {
    server.use(
      http.get('https://api.freelo.io/v1/task/7', () =>
        HttpResponse.json({
          id: 7,
          custom_fields: [{ field_uuid: FIELD_UUID, value_uuid: VALUE_UUID }],
        }),
      ),
      http.get('https://api.freelo.io/v1/task/8', () =>
        HttpResponse.json({ id: 8, custom_fields: [] }),
      ),
      customFieldsValueHandlers.deleteOk(),
    );
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--stdin',
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
    } finally {
      restore();
    }
  });

  it('NDJSON parse error → idMaybe===null → no task_id in error context', async () => {
    const restore = pipeStdin('{"bogus"\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
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
      expect(env.error.context).toHaveProperty('line_index', 0);
      expect(env.error.context).not.toHaveProperty('task_id');
    } finally {
      restore();
    }
  });

  it('mid-stream wire failure: success + error envelopes, exit 4', async () => {
    server.use(
      http.get('https://api.freelo.io/v1/task/7', () =>
        HttpResponse.json({
          id: 7,
          custom_fields: [{ field_uuid: FIELD_UUID, value_uuid: VALUE_UUID }],
        }),
      ),
      http.get('https://api.freelo.io/v1/task/8', () =>
        HttpResponse.json({ errors: ['Server boom.'] }, { status: 500 }),
      ),
      customFieldsValueHandlers.deleteOk(),
    );
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.value-clear/v1');
      expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
      expect((lines[1] as { error: { context: Record<string, unknown> } }).error.context).toEqual(
        expect.objectContaining({ line_index: 1, task_id: 8 }),
      );
    } finally {
      restore();
    }
  });

  it('empty stdin: no output, exit 0', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields value clear — human output', () => {
  it('live success --output human: prints "Cleared value..."', async () => {
    server.use(
      customFieldsValueHandlers.getTaskWithCustomFields(7, [
        { field_uuid: FIELD_UUID, value_uuid: VALUE_UUID },
      ]),
      customFieldsValueHandlers.deleteOk(),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Cleared value');
    expect(stdout).toContain('task #7');
  });

  it('already-absent --output human: prints "already had no value"', async () => {
    server.use(customFieldsValueHandlers.getTaskWithCustomFields(7, []));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/already had no value/i);
  });

  it('dry-run --output human: prints "(dry-run) Would clear..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'clear',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('Would clear value');
  });

  it('batch --stdin --output human with one failure: success line + failed item line', async () => {
    server.use(
      http.get('https://api.freelo.io/v1/task/7', () =>
        HttpResponse.json({
          id: 7,
          custom_fields: [{ field_uuid: FIELD_UUID, value_uuid: VALUE_UUID }],
        }),
      ),
      http.get('https://api.freelo.io/v1/task/8', () =>
        HttpResponse.json({ errors: ['Boom.'] }, { status: 500 }),
      ),
      customFieldsValueHandlers.deleteOk(),
    );
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--stdin',
        '--yes',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(4);
      // First line: success
      expect(stdout).toContain('Cleared value');
      // Second line: writeBatchError human branch
      expect(stdout).toContain('Failed item 2');
      expect(stdout).toContain('task #8');
    } finally {
      restore();
    }
  });

  it('NDJSON parse error --output human: failed-item line without task id', async () => {
    const restore = pipeStdin('{"bogus"\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'clear',
        '--stdin',
        '--yes',
        '--output',
        'human',
      ]);
      expect(exitCode).toBeGreaterThan(0);
      expect(stdout).toContain('Failed item 1');
      expect(stdout).not.toContain('(task #');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields value clear — introspect', () => {
  it('lists `custom-fields value clear` with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields value clear');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.custom-fields.value-clear/v1');
    expect(entry?.destructive).toBe(true);
  });
});

describe('isIdempotentDeleteSkip — heuristic matrix', () => {
  it('arm 1: 404 returns true', () => {
    const err = new FreeloApiError('Not found', 'NOT_FOUND', { httpStatus: 404 });
    expect(isIdempotentDeleteSkip(err)).toBe(true);
  });

  it('arm 2: 400 returns false', () => {
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
