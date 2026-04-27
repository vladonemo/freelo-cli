/**
 * End-to-end tests for `freelo tasks description set` (R15, spec 0026).
 *
 * Covers:
 *   - --from-file happy path
 *   - --dry-run
 *   - Source mutex (none, two)
 *   - --from-file ENOENT
 *   - --editor non-TTY
 *   - HTTP errors: 401/403/404/422/5xx/network/429 (Calibration §2)
 *   - Wire-body capture
 *   - Human renderer
 *   - Introspect entry (destructive: false)
 *
 * Note on stdin mode: stdin tests in the integration layer follow the same
 * mock pattern as `test/commands/auth/login.test.ts` for `--api-key-stdin`;
 * direct stdin coverage of the helper lives in `test/lib/input.test.ts`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksDescriptionHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-desc-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  id: 999_001,
  content: '<p>Updated body</p>',
  date_add: '2026-04-27T12:00:00Z',
  files: [],
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo tasks description set — happy paths', () => {
  it('--from-file: exit 0, schema, source="file", byte_length matches', async () => {
    const path = join(testDir, 'desc.txt');
    const body = 'Hello — rich text body with é unicode.';
    await writeFile(path, body, 'utf8');
    server.use(tasksDescriptionHandlers.setOk(9012, RESPONSE_OK));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
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
        description: { id: number };
      };
    };
    expect(env.schema).toBe('freelo.tasks.description.set/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.source).toBe('file');
    expect(env.data.description.id).toBe(999_001);
    // Byte-length covers UTF-8 multibyte (é = 2 bytes).
    expect(env.data.byte_length).toBe(Buffer.byteLength(body, 'utf8'));
  });

  it('--from-file --dry-run: no POST, dry_run=true, would echoes path+body', async () => {
    const path = join(testDir, 'desc.txt');
    const body = 'Dry-run body.';
    await writeFile(path, body, 'utf8');
    // No handler registered — onUnhandledRequest:'error' would trip if a POST happens.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
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
        description?: unknown;
        source?: unknown;
        would: { method: string; path: string; body: { content: string } };
      };
    };
    expect(env.schema).toBe('freelo.tasks.description.set/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(9012);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/task/9012/description');
    expect(env.data.would.body.content).toBe(body);
    expect(env.data.byte_length).toBe(body.length);
    // Live-only fields must be absent in dry-run envelopes.
    expect('description' in env.data).toBe(false);
    expect('source' in env.data).toBe(false);
  });

  it('wire body: { content: <body> } is sent (predicate captures)', async () => {
    const path = join(testDir, 'desc.txt');
    const body = 'Body that the predicate captures.';
    await writeFile(path, body, 'utf8');
    let captured: { content?: string } | undefined;
    server.use(
      tasksDescriptionHandlers.setOkWhenBody(
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
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toBeDefined();
    expect(captured!.content).toBe(body);
  });

  it('human mode: renders "Updated description for task #9012 (X bytes from file)."', async () => {
    const path = join(testDir, 'desc.txt');
    await writeFile(path, 'short body', 'utf8');
    server.use(tasksDescriptionHandlers.setOk(9012, RESPONSE_OK));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Updated description for task #9012');
    expect(stdout).toContain('bytes from file');
  });

  it('human dry-run: renders "(dry-run) Would POST <path>"', async () => {
    const path = join(testDir, 'desc.txt');
    await writeFile(path, 'body', 'utf8');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would POST /task/9012/description');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks description set — validation', () => {
  it('non-numeric <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      'abc',
      '--from-file',
      join(testDir, 'x.txt'),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('no source flag at all: VALIDATION_ERROR exit 2 with "exactly one"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('exactly one');
  });

  it('--from-file plus - (stdin): VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'desc.txt');
    await writeFile(path, 'body', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '-',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('--from-file plus --editor: VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'desc.txt');
    await writeFile(path, 'body', 'utf8');
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
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

  it('--from-file with missing file: VALIDATION_ERROR exit 2 with "not found"', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
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
    // Default: stdin is not a TTY (set in beforeEach).
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--editor',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    expect(stderr).toContain('interactive');
  });

  it('--from-file with empty content: VALIDATION_ERROR exit 2', async () => {
    const path = join(testDir, 'empty.txt');
    await writeFile(path, '', 'utf8');

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
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

  it('unexpected positional (not "-"): VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      'something-else',
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

describe('freelo tasks description set — HTTP errors', () => {
  async function setupBodyFile(): Promise<string> {
    const path = join(testDir, 'desc.txt');
    await writeFile(path, 'body', 'utf8');
    return path;
  }

  it('401: AUTH_EXPIRED exit 3', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setUnauthorized(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('403: FORBIDDEN exit 4 with permission hint', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setForbidden(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
  });

  it('404: NOT_FOUND exit 4 with "not found" hint', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setNotFound(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
  });

  it('422: FREELO_API_ERROR exit 4 (no hint rewrite)', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setUnprocessable(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
    // 404/403 specific hints must NOT fire.
    expect(stderr).not.toContain('Task 9012 not found');
    expect(stderr).not.toContain('permission to set description');
  });

  it('5xx: SERVER_ERROR exit 4', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setServerError(9012, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('429: RATE_LIMITED exit 6', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setRateLimited(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('network: NETWORK_ERROR exit 5', async () => {
    const path = await setupBodyFile();
    server.use(tasksDescriptionHandlers.setNetworkError(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'set',
      '9012',
      '--from-file',
      path,
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

describe('freelo tasks description set — introspect', () => {
  it('lists "tasks description set" with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'tasks description set');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.tasks.description.set/v1');
    expect(entry?.destructive).toBe(false);
  });
});
