/**
 * End-to-end tests for `freelo tasklists create` (R34, spec 0047).
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class (`ValidationError`, `FreeloApiError`,
 * `RateLimitedError`, `NetworkError`) has a triggering test.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasklistsCreateHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasklists', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

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

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-tasklists-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasklists create — happy paths', () => {
  it('minimal flags: --project + --name → JSON envelope, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    server.use(tasklistsCreateHandlers.ok(100, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'QA checklist',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; tasklist: { id: number; name: string } };
    };
    expect(env.schema).toBe('freelo.tasklists.create/v1');
    expect(env.data.project_id).toBe(100);
    expect(env.data.tasklist.id).toBe(9001);
    expect(env.data.tasklist.name).toBe('QA checklist');
  });

  it('every flag set: body builder output asserted on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    let capturedBody: unknown;
    server.use(
      tasklistsCreateHandlers.okWhenBody(
        100,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'QA checklist',
      '--budget',
      '100000',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({ name: 'QA checklist', budget: '100000' });
  });

  it('human mode renders the success line', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    server.use(tasklistsCreateHandlers.ok(100, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'QA checklist',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created tasklist #9001');
    expect(stdout).toContain('QA checklist');
    expect(stdout).toContain('project #100');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasklists create — dry-run', () => {
  it('--dry-run: no HTTP, envelope carries dry_run + would', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'QA checklist',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        project_id: number;
        would: { method: string; path: string; body: Record<string, unknown> };
        tasklist?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.tasklists.create/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.project_id).toBe(100);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/project/100/tasklists',
      body: { name: 'QA checklist' },
    });
    expect(env.data.tasklist).toBeUndefined();
  });

  it('--dry-run with --budget: would.body.budget is set verbatim', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '42',
      '--name',
      'Sprint 7',
      '--budget',
      '250000',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({ name: 'Sprint 7', budget: '250000' });
  });

  it('--dry-run human mode renders "Would create" line', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '42',
      '--name',
      'Test',
      '--budget',
      '100000',
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run)');
    expect(stdout).toContain('Would create tasklist "Test"');
    expect(stdout).toContain('project #42');
    expect(stdout).toContain('+ budget: 100000');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors (exit 2)
// ---------------------------------------------------------------------------

describe('freelo tasklists create — validation errors', () => {
  it('missing --project → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--project is required/);
  });

  it('--project 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '0',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing --name → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--name is required/);
  });

  it('whitespace-only --name → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      '   ',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--budget with separator → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--budget',
      '1000.00',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next: string | null } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/base units/i);
  });

  it('--budget non-numeric → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--budget',
      'lots',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  HTTP / network errors
// ---------------------------------------------------------------------------

describe('freelo tasklists create — API errors', () => {
  it('400 → FREELO_API_ERROR exit 4 with validation hint', async () => {
    server.use(tasklistsCreateHandlers.badRequest(100, 'Some validation problem.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.http_status).toBe(400);
    expect(env.error.hint_next).toMatch(/Server-side validation/i);
  });

  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasklistsCreateHandlers.unauthorized(100));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('403 → FORBIDDEN exit 4 with permission hint', async () => {
    server.use(tasklistsCreateHandlers.forbidden(100));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; hint_next: string | null };
    };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.hint_next).toMatch(/permission/i);
  });

  it('404 → FREELO_API_ERROR exit 4 with project-not-found hint', async () => {
    server.use(tasklistsCreateHandlers.notFound(100));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next: string | null };
    };
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/Project not found/i);
  });

  it('429 → RATE_LIMITED exit 6 retryable', async () => {
    server.use(tasklistsCreateHandlers.rateLimited(100));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string; retryable: boolean } };
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('5xx → SERVER_ERROR exit 4', async () => {
    server.use(tasklistsCreateHandlers.serverError(100, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });

  it('network error → NETWORK_ERROR exit 5', async () => {
    server.use(tasklistsCreateHandlers.networkError(100));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create',
      '--project',
      '100',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo tasklists create — introspect', () => {
  it('--introspect lists `tasklists create` with output schema and destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          output_schema?: string;
          destructive?: boolean;
        }>;
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'tasklists create');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.tasklists.create/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
