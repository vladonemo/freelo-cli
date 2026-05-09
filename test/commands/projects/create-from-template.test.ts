/**
 * End-to-end tests for `freelo projects create-from-template` (R31, spec 0044).
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call, not just "an error envelope was emitted."
 * Calibration §2: each typed error class (`ValidationError`, `FreeloApiError`,
 * `RateLimitedError`, `NetworkError`) has a triggering test.
 *
 * Mirrors the structure of `test/commands/projects/create.test.ts` (R29).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsCreateFromTemplateHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_ID = 4567;

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
    `freelo-projects-cft-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects create-from-template — happy paths', () => {
  it('minimal flags: <template_id> + --name → JSON envelope, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9001.json');
    server.use(projectsCreateFromTemplateHandlers.ok(TEMPLATE_ID, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'Acme Q3',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        template_id: number;
        project: { id: number; name: string; currency_iso?: string };
      };
    };
    expect(env.schema).toBe('freelo.projects.create-from-template/v1');
    expect(env.data.template_id).toBe(TEMPLATE_ID);
    expect(env.data.project.id).toBe(9001);
    expect(env.data.project.name).toBe('Acme Q3');
    expect(env.data.project.currency_iso).toBe('EUR');
  });

  it('every flag set: body builder output asserted on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9001.json');
    let capturedBody: unknown;
    server.use(
      projectsCreateFromTemplateHandlers.okWhenBody(
        TEMPLATE_ID,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'Acme Q3',
      '--owner-id',
      '314',
      '--currency',
      'CZK',
      '--date-start',
      '2026-09-01',
      '--layout',
      'kanban',
      '--worker',
      '12',
      '--worker',
      '34',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      name: 'Acme Q3',
      project_owner_id: 314,
      currency_iso: 'CZK',
      preset_date_from: '2026-09-01',
      general_settings: { layout: 'kanban' },
      users_ids: [12, 34],
    });
  });

  it('--currency lowercase is accepted and uppercased on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9001.json');
    let capturedBody: unknown;
    server.use(
      projectsCreateFromTemplateHandlers.okWhenBody(
        TEMPLATE_ID,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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

  it('--layout uppercase is accepted and lowercased on the wire', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9001.json');
    let capturedBody: unknown;
    server.use(
      projectsCreateFromTemplateHandlers.okWhenBody(
        TEMPLATE_ID,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--layout',
      'KANBAN',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect((capturedBody as { general_settings: { layout: string } }).general_settings.layout).toBe(
      'kanban',
    );
  });

  it('human mode renders the success line with template id', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-from-template-9001.json');
    server.use(projectsCreateFromTemplateHandlers.ok(TEMPLATE_ID, created));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'Acme Q3',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created project #9001');
    expect(stdout).toContain('Acme Q3');
    expect(stdout).toContain(`from template #${TEMPLATE_ID}`);
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects create-from-template — dry-run', () => {
  it('--dry-run: no HTTP, envelope carries dry_run + would', async () => {
    // No MSW handler registered — MSW would error if a request escaped.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'Acme Q3',
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
        project?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.projects.create-from-template/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.template_id).toBe(TEMPLATE_ID);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe(`/project/create-from-template/${TEMPLATE_ID}`);
    expect(env.data.would.body).toEqual({ name: 'Acme Q3' });
    expect(env.data.project).toBeUndefined();
  });

  it('--dry-run with full flag set: would.body has nested + array fields', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'Acme Q3',
      '--owner-id',
      '42',
      '--currency',
      'USD',
      '--date-start',
      '2026-09-01',
      '--layout',
      'kanban',
      '--worker',
      '12',
      '--worker',
      '34',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({
      name: 'Acme Q3',
      project_owner_id: 42,
      currency_iso: 'USD',
      preset_date_from: '2026-09-01',
      general_settings: { layout: 'kanban' },
      users_ids: [12, 34],
    });
  });

  it('--dry-run human mode renders "Would create" line with template id', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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
    expect(stdout).toContain(`from template #${TEMPLATE_ID}`);
    expect(stdout).toContain('currency: USD');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors (exit 2)
// ---------------------------------------------------------------------------

describe('freelo projects create-from-template — validation errors', () => {
  it('non-numeric <template_id> → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      'abc',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/template_id/);
  });

  it('<template_id> 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
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
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      '   ',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('bad --currency (GBP) → VALIDATION_ERROR exit 2 with enum hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--currency',
      'GBP',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/CZK.*EUR.*USD/);
  });

  it('--owner-id 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--owner-id',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--owner-id non-numeric → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--owner-id',
      'abc',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--date-start with slashes → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--date-start',
      '2026/09/01',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/YYYY-MM-DD/);
  });

  it('--date-start with bad calendar (2026-13-40) → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--date-start',
      '2026-13-40',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--date-start Feb 30 (round-trip rejection) → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--date-start',
      '2026-02-30',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--layout grid → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--layout',
      'grid',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/rows.*kanban/);
  });

  it('--worker 0 → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--worker',
      '0',
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
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
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

describe('freelo projects create-from-template — API errors', () => {
  it('400 with project_owner_id in message → owner-flavored hint, exit 4', async () => {
    server.use(
      projectsCreateFromTemplateHandlers.badRequest(
        TEMPLATE_ID,
        'project_owner_id 999 is not valid',
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--owner-id',
      '999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.error.http_status).toBe(400);
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.hint_next).toMatch(/owner-eligible/i);
  });

  it('400 with users_ids in message → workers-flavored hint, exit 4', async () => {
    server.use(
      projectsCreateFromTemplateHandlers.badRequest(
        TEMPLATE_ID,
        'users_ids contains values not in template members',
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--worker',
      '999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; hint_next: string | null };
    };
    expect(env.error.hint_next).toMatch(/template/i);
  });

  it('400 generic → generic validation hint, exit 4', async () => {
    server.use(
      projectsCreateFromTemplateHandlers.badRequest(TEMPLATE_ID, 'Other validation problem.'),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
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
    server.use(projectsCreateFromTemplateHandlers.unauthorized(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
    expect(env.error.http_status).toBe(401);
  });

  it('403 → FORBIDDEN exit 4 with permission hint', async () => {
    server.use(projectsCreateFromTemplateHandlers.forbidden(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
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

  it('404 → NOT_FOUND exit 4 with template-not-found hint', async () => {
    server.use(projectsCreateFromTemplateHandlers.notFound(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number; hint_next: string | null };
    };
    // 404 maps to the dedicated NOT_FOUND code (see FreeloApiError.fromHttp);
    // our rewriteApiHint preserves err.code while specializing hint_next.
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/template/i);
  });

  it('422 → FREELO_API_ERROR exit 4', async () => {
    server.use(projectsCreateFromTemplateHandlers.unprocessable(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('FREELO_API_ERROR');
    expect(env.error.http_status).toBe(422);
  });

  it('429 → RATE_LIMITED exit 6 retryable', async () => {
    server.use(projectsCreateFromTemplateHandlers.rateLimited(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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
    server.use(projectsCreateFromTemplateHandlers.serverError(TEMPLATE_ID, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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
    server.use(projectsCreateFromTemplateHandlers.networkError(TEMPLATE_ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'create-from-template',
      String(TEMPLATE_ID),
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

describe('freelo projects create-from-template — introspect', () => {
  it('--introspect lists `projects create-from-template` with output schema', async () => {
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
    const cmd = env.data.commands.find((c) => c.name === 'projects create-from-template');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.create-from-template/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
