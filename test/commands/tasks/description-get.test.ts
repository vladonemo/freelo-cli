/**
 * End-to-end tests for `freelo tasks description get` (R15, spec 0026).
 *
 * Covers:
 *   - 200 with content: schema, data.description.content matches.
 *   - 200 with empty/null content: passthrough.
 *   - HTTP errors: 401/403/404/422/5xx/network. Each typed error class
 *     triggered (Calibration §2).
 *   - Validation: <id> non-numeric / zero / negative.
 *   - Human renderer.
 *   - Introspect entry (destructive: false).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksShowHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-desc-get-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

const FILLED_DESCRIPTION = {
  id: 999_001,
  content: '<p>Task body — rich text.</p>',
  date_add: '2026-04-27T10:00:00Z',
  files: [],
};

const EMPTY_DESCRIPTION = {
  id: null,
  content: null,
  date_add: null,
  files: [],
};

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo tasks description get — happy paths', () => {
  it('200 with content: schema + data.description.content matches', async () => {
    server.use(tasksShowHandlers.descriptionOk(9012, FILLED_DESCRIPTION));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; description: { id: number; content: string } };
    };
    expect(env.schema).toBe('freelo.tasks.description.get/v1');
    expect(env.data.task_id).toBe(9012);
    expect(env.data.description.content).toBe('<p>Task body — rich text.</p>');
    expect(env.data.description.id).toBe(999_001);
  });

  it('200 with empty/null fields: passthrough', async () => {
    server.use(tasksShowHandlers.descriptionOk(9012, EMPTY_DESCRIPTION));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { description: { id: number | null; content: string | null } };
    };
    expect(env.data.description.id).toBeNull();
    expect(env.data.description.content).toBeNull();
  });

  it('human renderer: prints "Task #N description:" + body + "Updated <iso>"', async () => {
    server.use(tasksShowHandlers.descriptionOk(9012, FILLED_DESCRIPTION));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Task #9012 description:');
    expect(stdout).toContain('<p>Task body — rich text.</p>');
    expect(stdout).toContain('Updated 2026-04-27T10:00:00Z');
  });

  it('human renderer with empty content renders "(empty)"', async () => {
    server.use(tasksShowHandlers.descriptionOk(9012, EMPTY_DESCRIPTION));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(empty)');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks description get — validation', () => {
  it('non-numeric <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });

  it('zero <id>: VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  HTTP errors (Calibration §2)
// ---------------------------------------------------------------------------

describe('freelo tasks description get — HTTP errors', () => {
  it('401: AUTH_EXPIRED exit 3', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get(
        'https://api.freelo.io/v1/task/9012/description',
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Invalid token.'] }), {
            status: 401,
            headers: { 'Content-Type': 'application/json' },
          }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('403: FORBIDDEN exit 4, hint mentions permission', async () => {
    server.use(tasksShowHandlers.descriptionForbidden(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FORBIDDEN');
    expect(stderr).toContain('permission');
  });

  it('404: NOT_FOUND exit 4, hint mentions not found', async () => {
    server.use(tasksShowHandlers.descriptionNotFound(9012));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('NOT_FOUND');
    expect(stderr).toContain('not found');
  });

  it('5xx: SERVER_ERROR exit 4', async () => {
    server.use(tasksShowHandlers.descriptionServerError(9012, 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('SERVER_ERROR');
  });

  it('429: RATE_LIMITED exit 6', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get(
        'https://api.freelo.io/v1/task/9012/description',
        () =>
          new HttpResponse(JSON.stringify({ errors: ['Rate limited.'] }), {
            status: 429,
            headers: { 'Content-Type': 'application/json', 'Retry-After': '0' },
          }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    expect(stderr).toContain('RATE_LIMITED');
  });

  it('network: NETWORK_ERROR exit 5', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/task/9012/description', () => HttpResponse.error()),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    expect(stderr).toContain('NETWORK_ERROR');
  });

  it('422 (non-404/403): hint passes through unchanged', async () => {
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/task/9012/description', () =>
        HttpResponse.json({ errors: ['Bad request.'] }, { status: 422 }),
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'description',
      'get',
      '9012',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stderr).toContain('FREELO_API_ERROR');
    // The 404/403 specific hint must NOT fire on 422.
    expect(stderr).not.toContain('Description for task 9012 not found');
    expect(stderr).not.toContain('permission to view description');
  });
});

// ---------------------------------------------------------------------------
//  Introspect
// ---------------------------------------------------------------------------

describe('freelo tasks description get — introspect', () => {
  it('lists "tasks description get" with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const entry = env.data.commands.find((c) => c.name === 'tasks description get');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.tasks.description.get/v1');
    expect(entry?.destructive).toBe(false);
  });
});
