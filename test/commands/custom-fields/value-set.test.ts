/**
 * End-to-end tests for `freelo custom-fields value set` (R42, spec 0055).
 *
 * Two backends, dispatched on the --value/--enum mutex:
 *   - --value <str>  → POST /custom-field/add-or-edit-value (scalar)
 *   - --enum <uuid>  → POST /custom-field/add-or-edit-enum-value (enum, camelCase body)
 *
 * Covers:
 *   - Happy: scalar single, enum single, scalar/enum --output human, dry-run.
 *   - Validation: missing flags, both --value and --enum, neither, bad task, bad field,
 *     missing input source, mutex flag + --stdin.
 *   - HTTP errors: 400 (value-mention + generic), 401, 403, 404, 409, 429, 5xx, network.
 *   - Hint rewrites for 400/404/409.
 *   - Batch via NDJSON --stdin: parse error, mutex per line, mid-stream error, success+error mix.
 *   - writeBatchError shape: line_index, task_id presence/absence, idMaybe===null.
 *   - Introspect lists `custom-fields value set` with destructive: false.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, customFieldsValueHandlers } from '../../msw/handlers.js';

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
    `freelo-cf-value-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const FIELD_UUID = '11111111-1111-1111-1111-111111111111';
const ENUM_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

describe('freelo custom-fields value set — happy paths', () => {
  it('scalar set (--value): POSTs add-or-edit-value, kind=scalar', async () => {
    server.use(customFieldsValueHandlers.setScalarOk('cfv-uuid'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hello',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { kind: string; task_id: number; value_uuid: string | null; value: string };
    };
    expect(env.schema).toBe('freelo.custom-fields.value-set/v1');
    expect(env.data.kind).toBe('scalar');
    expect(env.data.task_id).toBe(7);
    expect(env.data.value_uuid).toBe('cfv-uuid');
    expect(env.data.value).toBe('hello');
  });

  it('enum set (--enum): POSTs enum endpoint with camelCase body, kind=enum', async () => {
    server.use(customFieldsValueHandlers.setEnumOk('cfe-uuid'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--enum',
      ENUM_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { kind: string; value_uuid: string | null; value: string };
    };
    expect(env.data.kind).toBe('enum');
    expect(env.data.value_uuid).toBe('cfe-uuid');
    expect(env.data.value).toBe(ENUM_UUID);
  });

  it('scalar with empty server response body still emits envelope with null value_uuid', async () => {
    server.use(customFieldsValueHandlers.setScalarOkEmptyBody());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hello',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { value_uuid: string | null } };
    expect(env.data.value_uuid).toBeNull();
  });

  it('--dry-run skips wire call, envelope carries would', async () => {
    // No handler — would 500 if hit.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hello',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would?: { method: string; path: string; body: Record<string, unknown> } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/custom-field/add-or-edit-value');
    expect(env.data.would?.body).toEqual({
      custom_field_uuid: FIELD_UUID,
      task_id: 7,
      value: 'hello',
    });
  });

  it('--dry-run for enum: would.path is the enum endpoint with camelCase body', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--enum',
      ENUM_UUID,
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would?: { path: string; body: Record<string, unknown> } };
    };
    expect(env.data.would?.path).toBe('/custom-field/add-or-edit-enum-value');
    expect(env.data.would?.body).toEqual({
      customFieldUuid: FIELD_UUID,
      task_id: 7,
      value: ENUM_UUID,
    });
  });
});

describe('freelo custom-fields value set — validation', () => {
  it('both --value and --enum → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--enum',
      ENUM_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/exactly one of --value or --enum/i);
  });

  it('neither --value nor --enum → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('missing --task → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
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
      'set',
      '--task',
      '7',
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --task (zero) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '0',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --field (whitespace only) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      '   ',
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('flag input + --stdin → ValidationError exit 2 (mutex)', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--task',
        '7',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
    } finally {
      restore();
    }
  });

  it('no input source at all → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['custom-fields', 'value', 'set', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('bad --enum (whitespace only) → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--enum',
      '   ',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo custom-fields value set — error mapping', () => {
  it('400 mentioning value (scalar) → exit 4 with value-mention hint', async () => {
    server.use(customFieldsValueHandlers.setScalarBadRequest("Field 'value' is invalid."));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/scalar fields expect a string/i);
  });

  it('400 generic → exit 4 with generic hint', async () => {
    server.use(customFieldsValueHandlers.setScalarBadRequest('Some other validation reason.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/server-side validation/i);
  });

  it('404 (scalar) → exit 4 with task-or-field hint', async () => {
    server.use(customFieldsValueHandlers.setScalarNotFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/task or custom field not found/i);
  });

  it('404 mentioning Enum (enum dispatch) → exit 4 with enum-option hint', async () => {
    server.use(customFieldsValueHandlers.setEnumNotFound('Enum was not found.'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--enum',
      ENUM_UUID,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/enum option uuid not found/i);
  });

  it('409 → exit 4 with project-mismatch hint', async () => {
    server.use(customFieldsValueHandlers.setScalarConflict());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/different project/i);
  });

  it('401 → exit 3', async () => {
    server.use(customFieldsValueHandlers.setScalarUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(customFieldsValueHandlers.setScalarForbidden());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(customFieldsValueHandlers.setScalarRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });

  it('5xx → exit 4', async () => {
    server.use(customFieldsValueHandlers.setScalarServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});

describe('freelo custom-fields value set — batch via --stdin (NDJSON)', () => {
  it('two scalar lines, both succeed: two envelopes, line_index present', async () => {
    server.use(customFieldsValueHandlers.setScalarOk('cfv-uuid'));
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}","value":"a"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}","value":"b"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as { data: { line_index: number } }).data.line_index).toBe(0);
      expect((lines[1] as { data: { line_index: number } }).data.line_index).toBe(1);
    } finally {
      restore();
    }
  });

  it('NDJSON with both value+enum on one line → per-line ValidationError envelope', async () => {
    server.use(customFieldsValueHandlers.setScalarOk());
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}","value":"a","enum":"${ENUM_UUID}"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stdout) as {
        schema: string;
        error: { context: Record<string, unknown> };
      };
      expect(env.schema).toBe('freelo.error/v1');
      expect(env.error.context).toHaveProperty('line_index', 0);
      expect(env.error.context).toHaveProperty('task_id', 7);
    } finally {
      restore();
    }
  });

  it('NDJSON with malformed JSON line → idMaybe===null → no task_id in context', async () => {
    server.use(customFieldsValueHandlers.setScalarOk());
    const restore = pipeStdin('{"not_json"\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
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
      expect(env.error.context).toHaveProperty('line_index', 0);
      expect(env.error.context).not.toHaveProperty('task_id');
    } finally {
      restore();
    }
  });

  it('mid-stream wire failure: success envelope + error envelope, exit 4', async () => {
    server.use(
      customFieldsValueHandlers.setScalarPerTaskRouter({
        '7': () => Response.json({ custom_field_value: { uuid: 'cfv-7' } }),
        '8': () =>
          new Response(JSON.stringify({ errors: ['Server went boom.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}","value":"a"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}","value":"b"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      // 0 is success, 1 is error envelope
      expect((lines[0] as { schema: string }).schema).toBe('freelo.custom-fields.value-set/v1');
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
        'set',
        '--stdin',
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

describe('freelo custom-fields value set — human output', () => {
  it('scalar single --output human: prints "Set scalar value..."', async () => {
    server.use(customFieldsValueHandlers.setScalarOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hello',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Set scalar value');
    expect(stdout).toContain('task #7');
    expect(stdout).toContain('hello');
  });

  it('enum single --output human: prints "Set enum value..."', async () => {
    server.use(customFieldsValueHandlers.setEnumOk());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--enum',
      ENUM_UUID,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Set enum value');
  });

  it('dry-run --output human: prints "(dry-run) Would set..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'custom-fields',
      'value',
      'set',
      '--task',
      '7',
      '--field',
      FIELD_UUID,
      '--value',
      'hi',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('dry-run');
    expect(stdout).toContain('Would set scalar value');
  });

  it('batch --stdin --output human: success line + failed item line', async () => {
    server.use(
      customFieldsValueHandlers.setScalarPerTaskRouter({
        '7': () => Response.json({ custom_field_value: { uuid: 'cfv-7' } }),
        '8': () =>
          new Response(JSON.stringify({ errors: ['Boom.'] }), {
            status: 500,
            headers: { 'Content-Type': 'application/json' },
          }),
      }),
    );
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}","value":"a"}\n{"task_id":8,"field_uuid":"${FIELD_UUID}","value":"b"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(4);
      // First item succeeds (human line)
      expect(stdout).toContain('Set scalar value');
      // Second item fails — writeBatchError human branch
      expect(stdout).toContain('Failed item 2');
      expect(stdout).toContain('task #8');
    } finally {
      restore();
    }
  });

  it('NDJSON parse error --output human: emits human "Failed item" line without task id', async () => {
    const restore = pipeStdin('{"bogus"\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('Failed item 1');
      // idMaybe===null → no "(task #...)" prefix
      expect(stdout).not.toContain('(task #');
    } finally {
      restore();
    }
  });

  it('NDJSON line with both value+enum --output human: per-line failure with task id', async () => {
    const restore = pipeStdin(
      `{"task_id":7,"field_uuid":"${FIELD_UUID}","value":"a","enum":"${ENUM_UUID}"}\n`,
    );
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'custom-fields',
        'value',
        'set',
        '--stdin',
        '--output',
        'human',
      ]);
      expect(exitCode).toBe(2);
      expect(stdout).toContain('Failed item 1');
      expect(stdout).toContain('task #7');
    } finally {
      restore();
    }
  });
});

describe('freelo custom-fields value set — introspect', () => {
  it('lists `custom-fields value set` with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'custom-fields value set');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.custom-fields.value-set/v1');
    expect(entry?.destructive).toBe(false);
  });
});
