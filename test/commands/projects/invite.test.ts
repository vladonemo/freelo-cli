/**
 * End-to-end tests for `freelo projects invite` (R33, spec 0046).
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: every typed error class triggered has at least one test.
 * Calibration §4: the new try/catch arms (rewriteInviteApiHint dispatch on
 *   400 / 403 / 404 / 422) have explicit coverage.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsInviteHandlers } from '../../msw/handlers.js';

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
    `freelo-projects-invite-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects invite — happy paths', () => {
  it('--project 9001 --email new@x.io → exit 0; body has emails-only, no users_ids key', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return (
          JSON.stringify(b['projects_ids']) === '[9001]' &&
          JSON.stringify(b['emails']) === '["new@x.io"]' &&
          !('users_ids' in b)
        );
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        projects_ids: number[];
        users_ids?: number[];
        emails?: string[];
        result?: unknown;
      };
    };
    expect(env.schema).toBe('freelo.projects.invite/v1');
    expect(env.data.projects_ids).toEqual([9001]);
    expect(env.data.emails).toEqual(['new@x.io']);
    expect(env.data.users_ids).toBeUndefined();
    expect(env.data.result).toBeDefined();
  });

  it('--project x2 --user 305 → body has users_ids, no emails key', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return (
          JSON.stringify(b['projects_ids']) === '[9001,9002]' &&
          JSON.stringify(b['users_ids']) === '[305]' &&
          !('emails' in b)
        );
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--project',
      '9002',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { projects_ids: number[]; users_ids?: number[]; emails?: string[] };
    };
    expect(env.data.projects_ids).toEqual([9001, 9002]);
    expect(env.data.users_ids).toEqual([305]);
    expect(env.data.emails).toBeUndefined();
  });

  it('combined --user + --email in one call → both present in body and envelope (decision 2)', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return (
          JSON.stringify(b['users_ids']) === '[305]' &&
          JSON.stringify(b['emails']) === '["new@x.io"]'
        );
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { users_ids?: number[]; emails?: string[] };
    };
    expect(env.data.users_ids).toEqual([305]);
    expect(env.data.emails).toEqual(['new@x.io']);
  });

  it('duplicate --project values are deduplicated', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return JSON.stringify(b['projects_ids']) === '[9001]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('duplicate --user values are deduplicated first-seen-wins', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return JSON.stringify(b['users_ids']) === '[305,150]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '305',
      '--user',
      '150',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('duplicate --email values are deduplicated', async () => {
    server.use(
      projectsInviteHandlers.okWhenBody((body) => {
        const b = body as Record<string, unknown>;
        return JSON.stringify(b['emails']) === '["a@x.io","b@y.io"]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--email',
      'a@x.io',
      '--email',
      'b@y.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('envelope surfaces server result.newly_created_users on live success', async () => {
    server.use(
      projectsInviteHandlers.okWithResult({
        newly_created_users: [{ id: 5001, email: 'new@x.io' }],
        newly_invited_users: [{ id: 5001, email: 'new@x.io', projects_ids: [9001] }],
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        result?: {
          newly_created_users: { id?: number; email?: string }[];
          newly_invited_users: unknown[];
        };
      };
    };
    expect(env.data.result?.newly_created_users).toEqual([{ id: 5001, email: 'new@x.io' }]);
    expect(env.data.result?.newly_invited_users).toHaveLength(1);
  });

  it('human mode renders the success line', async () => {
    server.use(
      projectsInviteHandlers.okWithResult({
        newly_invited_users: [{ id: 5001, email: 'new@x.io', projects_ids: [9001] }],
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Invited 1 person to 1 project.');
  });

  it('human mode lists newly-created users in a bullet block', async () => {
    server.use(
      projectsInviteHandlers.okWithResult({
        newly_created_users: [{ id: 5001, email: 'new@x.io' }],
        newly_invited_users: [{ id: 5001, email: 'new@x.io', projects_ids: [9001] }],
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('newly created user, id 5001');
    expect(stdout).toContain('new@x.io');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects invite — dry-run', () => {
  it('--dry-run: no HTTP, envelope has dry_run + would (combined users + emails)', async () => {
    // No MSW handler — assert no HTTP fired.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--email',
      'new@x.io',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        projects_ids: number[];
        users_ids?: number[];
        emails?: string[];
        result?: unknown;
        would: {
          method: string;
          path: string;
          body: { projects_ids: number[]; users_ids?: number[]; emails?: string[] };
        };
      };
    };
    expect(env.schema).toBe('freelo.projects.invite/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.result).toBeUndefined();
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/users/manage-workers');
    expect(env.data.would.body).toEqual({
      projects_ids: [9001],
      users_ids: [305],
      emails: ['new@x.io'],
    });
  });

  it('--dry-run users-only: body omits emails key', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '150',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({ projects_ids: [9001], users_ids: [305, 150] });
    expect('emails' in env.data.would.body).toBe(false);
  });

  it('--dry-run emails-only: body omits users_ids key', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { would: { body: Record<string, unknown> } };
    };
    expect(env.data.would.body).toEqual({ projects_ids: [9001], emails: ['a@x.io'] });
    expect('users_ids' in env.data.would.body).toBe(false);
  });

  it('human dry-run renders "(dry-run) Would invite ..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--email',
      'a@x.io',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would invite 2 people to 1 project');
    expect(stdout).toContain('1 by id, 1 by email');
  });
});

// ---------------------------------------------------------------------------
//  Validation — calibration §2 (ValidationError exit 2)
// ---------------------------------------------------------------------------

describe('freelo projects invite — validation', () => {
  it('missing --project → exit 2 (ValidationError)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--project/);
  });

  it('--project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '0',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      'abc',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('neither --user nor --email → exit 2 with hint mentioning both flags', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--email|--user/);
  });

  it('--user 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--user abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--email "not-an-email" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'not-an-email',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--user and --email together is allowed (decision 2; not mutex)', async () => {
    server.use(projectsInviteHandlers.ok());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--email',
      'a@x.io',
      '--output',
      'json',
    ]);
    // Should NOT be a mutex error — exit 0 with both fields present.
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  API errors — calibration §2 + §4 (rewrite hint coverage)
// ---------------------------------------------------------------------------

describe('freelo projects invite — API errors', () => {
  it('400 with errors[] mentioning "emails" → email-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(
      projectsInviteHandlers.badRequestWithErrors([
        'The emails field must be a valid email format.',
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(400);
    expect(env.error.hint_next?.toLowerCase()).toContain('email');
  });

  it('400 with errors[] mentioning "users_ids" → user-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(
      projectsInviteHandlers.badRequestWithErrors(['The users_ids field contains an invalid id.']),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('user');
  });

  it('400 with errors[] mentioning "projects_ids" → project-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(
      projectsInviteHandlers.badRequestWithErrors([
        'The projects_ids field contains an unknown id.',
      ]),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('project');
  });

  it('400 generic (no field-name match) → generic hint, exit 4', async () => {
    server.use(projectsInviteHandlers.badRequest('Bad request.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toMatch(/review the message|adjust/);
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(projectsInviteHandlers.unauthorized());

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → permission hint, exit 4 (calibration §4)', async () => {
    server.use(projectsInviteHandlers.forbidden());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('permission');
  });

  it('403 with plan/seat language → plan-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(projectsInviteHandlers.forbidden('Plan limit exceeded.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('plan');
  });

  it('404 → project-not-found hint, exit 4 (calibration §4)', async () => {
    server.use(projectsInviteHandlers.notFound());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('not found');
  });

  it('422 (plan-exceeded) → plan-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(projectsInviteHandlers.unprocessable('Seat limit reached.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toMatch(/plan|seat/);
  });

  it('422 generic → generic hint, exit 4', async () => {
    server.use(projectsInviteHandlers.unprocessable('Some semantic error.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--email',
      'new@x.io',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(projectsInviteHandlers.rateLimited());

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });

  it('500 → SERVER_ERROR, exit 4', async () => {
    server.use(projectsInviteHandlers.serverError(500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network error → NETWORK_ERROR, exit 5', async () => {
    server.use(projectsInviteHandlers.networkError());

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'invite',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects invite — introspection', () => {
  it('--introspect lists `projects invite` with destructive=false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: { name: string; output_schema: string; destructive: boolean }[];
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects invite');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.invite/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
