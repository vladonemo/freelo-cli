/**
 * End-to-end tests for `freelo tasklists create-from-template` (R34, spec 0047).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasklistsCreateFromTemplateHandlers } from '../../msw/handlers.js';

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
    `freelo-tasklists-cft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasklists create-from-template — happy paths', () => {
  it('minimal: <template_id> + --source-tasklist → JSON envelope, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9002.json');
    server.use(tasklistsCreateFromTemplateHandlers.ok(50, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { template_id: number; tasklist: { id: number; name: string } };
    };
    expect(env.schema).toBe('freelo.tasklists.create-from-template/v1');
    expect(env.data.template_id).toBe(50);
    expect(env.data.tasklist.id).toBe(9002);
  });

  it('every flag set: body builder output asserted on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9002.json');
    let capturedBody: unknown;
    server.use(
      tasklistsCreateFromTemplateHandlers.okWhenBody(
        50,
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
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--target-project',
      '100',
      '--target-tasklist',
      '200',
      '--date-start',
      '2026-09-01',
      '--worker',
      '11',
      '--worker',
      '22',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      tasklist_id: 7,
      target_project_id: 100,
      target_tasklist_id: 200,
      preset_date_from: '2026-09-01',
      users_ids: [11, 22],
    });
  });

  it('human mode renders the success line', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9002.json');
    server.use(tasklistsCreateFromTemplateHandlers.ok(50, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created tasklist #9002');
    expect(stdout).toContain('template #50');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasklists create-from-template — dry-run', () => {
  it('--dry-run minimal: no HTTP, would echoes path + body', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        template_id: number;
        would: { method: string; path: string; body: Record<string, unknown> };
        tasklist?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.tasklists.create-from-template/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.template_id).toBe(50);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/tasklist/create-from-template/50',
      body: { tasklist_id: 7 },
    });
    expect(env.data.tasklist).toBeUndefined();
  });

  it('--dry-run human mode renders "Would create" line with sub-lines', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--target-project',
      '100',
      '--worker',
      '42',
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run)');
    expect(stdout).toContain('template #50');
    expect(stdout).toContain('source tasklist #7');
    expect(stdout).toContain('+ target-project: 100');
    expect(stdout).toContain('+ workers: 42');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors
// ---------------------------------------------------------------------------

describe('freelo tasklists create-from-template — validation errors', () => {
  it('non-numeric <template_id> → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      'abc',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('missing --source-tasklist → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--source-tasklist is required/);
  });

  it('--source-tasklist 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('bad --date-start format → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--date-start',
      '2026/09/01',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--date-start nonsense calendar (Feb 30) → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--date-start',
      '2026-02-30',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--worker non-numeric → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--worker',
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

describe('freelo tasklists create-from-template — API errors', () => {
  it('400 with users_ids reference → workers-not-in-template hint', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.badRequest(50, 'users_ids: invalid worker'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--worker',
      '99',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/members of the template/i);
  });

  it('400 with target_project_id reference → target-project hint', async () => {
    server.use(
      tasklistsCreateFromTemplateHandlers.badRequest(50, 'target_project_id: not accessible'),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--target-project',
      '999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/target project id/i);
  });

  it('400 generic → server-side validation hint', async () => {
    server.use(
      tasklistsCreateFromTemplateHandlers.badRequest(50, 'Some other validation problem.'),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/Server-side validation/i);
  });

  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.unauthorized(50));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('403 → FORBIDDEN exit 4 with permission hint', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.forbidden(50));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/permission/i);
  });

  it('404 → FREELO_API_ERROR exit 4 with template-not-found hint', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.notFound(999));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '999',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next: string | null } };
    expect(env.error.hint_next).toMatch(/Template not found/i);
  });

  it('429 → RATE_LIMITED exit 6 retryable', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.rateLimited(50));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string; retryable: boolean } };
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('5xx → SERVER_ERROR exit 4', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.serverError(50, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('SERVER_ERROR');
  });

  it('network error → NETWORK_ERROR exit 5', async () => {
    server.use(tasklistsCreateFromTemplateHandlers.networkError(50));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'create-from-template',
      '50',
      '--source-tasklist',
      '7',
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

describe('freelo tasklists create-from-template — introspect', () => {
  it('--introspect lists `tasklists create-from-template` with output schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema?: string; destructive?: boolean }>;
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'tasklists create-from-template');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.tasklists.create-from-template/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
