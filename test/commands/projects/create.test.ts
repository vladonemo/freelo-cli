/**
 * End-to-end tests for `freelo projects create` (R29, spec 0042).
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call, not just "an error envelope was emitted."
 * Calibration §2: each typed error class (`ValidationError`, `FreeloApiError`,
 * `RateLimitedError`, `NetworkError`) has a triggering test.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsCreateHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/projects', name);
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
    `freelo-projects-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects create — happy paths', () => {
  it('minimal flags: --name + --currency → JSON envelope, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    server.use(projectsCreateHandlers.ok(created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Q3 onboarding',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project: { id: number; name: string } };
    };
    expect(env.schema).toBe('freelo.projects.create/v1');
    expect(env.data.project.id).toBe(9001);
    expect(env.data.project.name).toBe('Q3 onboarding');
  });

  it('every flag set: body builder output asserted on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    let capturedBody: unknown;
    server.use(
      projectsCreateHandlers.okWhenBody((body) => {
        capturedBody = body;
        return true;
      }, created),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Acme migration',
      '--currency',
      'CZK',
      '--project-owner-id',
      '314',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      name: 'Acme migration',
      currency_iso: 'CZK',
      project_owner_id: 314,
    });
  });

  it('--currency lowercase is accepted and uppercased on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    let capturedBody: unknown;
    server.use(
      projectsCreateHandlers.okWhenBody((body) => {
        capturedBody = body;
        return true;
      }, created),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'eur',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect((capturedBody as { currency_iso: string }).currency_iso).toBe('EUR');
  });

  it('human mode renders the success line', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9001.json');
    server.use(projectsCreateHandlers.ok(created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Q3 onboarding',
      '--currency',
      'EUR',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created project #9001');
    expect(stdout).toContain('Q3 onboarding');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects create — dry-run', () => {
  it('--dry-run: no HTTP, envelope carries dry_run + would', async () => {
    // No MSW handler registered — the test asserts no HTTP fired (MSW
    // would error as unhandled if a request escaped).

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Q3 onboarding',
      '--currency',
      'EUR',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        would: { method: string; path: string; body: Record<string, unknown> };
        project?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.projects.create/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/projects',
      body: { name: 'Q3 onboarding', currency_iso: 'EUR' },
    });
    expect(env.data.project).toBeUndefined();
  });

  it('--dry-run with --project-owner-id: would.body.project_owner_id is set', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Acme',
      '--currency',
      'USD',
      '--project-owner-id',
      '42',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({
      name: 'Acme',
      currency_iso: 'USD',
      project_owner_id: 42,
    });
  });

  it('--dry-run human mode renders "Would create" line with currency', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'Test',
      '--currency',
      'USD',
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run)');
    expect(stdout).toContain('Would create project "Test"');
    expect(stdout).toContain('currency: USD');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors (exit 2)
// ---------------------------------------------------------------------------

describe('freelo projects create — validation errors', () => {
  it('missing --name → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; message: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--name is required/);
  });

  it('whitespace-only --name → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      '   ',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/non-empty/i);
  });

  it('missing --currency → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; message: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--currency is required/);
  });

  it('bad --currency (GBP) → VALIDATION_ERROR exit 2 with enum hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'GBP',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; message: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/CZK.*EUR.*USD/);
  });

  it('--project-owner-id 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--project-owner-id',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--project-owner-id non-numeric → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--project-owner-id',
      'abc',
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

describe('freelo projects create — API errors', () => {
  it('400 with project_owner_id in message → FREELO_API_ERROR exit 4 with owner-flavored hint', async () => {
    server.use(projectsCreateHandlers.badRequest('project_owner_id 999 is not valid'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--project-owner-id',
      '999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.http_status).toBe(400);
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.hint_next).toMatch(/owner-eligible/i);
  });

  it('400 without project_owner_id reference → generic validation hint, exit 4', async () => {
    server.use(projectsCreateHandlers.badRequest('Some other validation problem.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next: string | null };
    };
    expect(env.error.http_status).toBe(400);
    expect(env.error.hint_next).toMatch(/Server-side validation/i);
  });

  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(projectsCreateHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('AUTH_EXPIRED');
    expect(env.error.http_status).toBe(401);
  });

  it('403 → FORBIDDEN exit 4 with permission hint', async () => {
    server.use(projectsCreateHandlers.forbidden());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
  });

  it('422 → FREELO_API_ERROR exit 4', async () => {
    server.use(projectsCreateHandlers.unprocessable());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.http_status).toBe(422);
  });

  it('429 → RATE_LIMITED exit 6 retryable', async () => {
    server.use(projectsCreateHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as {
      error: { code: string; retryable: boolean };
    };
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('5xx → SERVER_ERROR exit 4', async () => {
    server.use(projectsCreateHandlers.serverError(503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });

  it('network error → NETWORK_ERROR exit 5', async () => {
    server.use(projectsCreateHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create',
      '--name',
      'X',
      '--currency',
      'EUR',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as {
      error: { code: string };
    };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects create — introspect', () => {
  it('--introspect lists `projects create` with output schema and destructive flag', async () => {
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
    const cmd = env.data.commands.find((c) => c.name === 'projects create');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.create/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
