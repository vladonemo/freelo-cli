/**
 * End-to-end tests for `freelo projects workers remove` (R32, spec 0045).
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: every typed error class triggered has at least one test.
 * Calibration §4: the new try/catch arms (rewriteRemoveApiHint dispatch on
 *   400 / 403 / 404) have explicit coverage.
 * Calibration §7: tests asserting TTY-prompt copy clear `process.env['CI']`.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsWorkersHandlers } from '../../msw/handlers.js';

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
    `freelo-projects-workers-remove-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths — by-ids
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — by ids', () => {
  it('--user 305 --user 150 --yes → success envelope, body assertion, exit 0', async () => {
    server.use(
      projectsWorkersHandlers.removeByIdsOkWhenBody(9001, (body) => {
        const b = body as { users_ids?: unknown };
        return Array.isArray(b.users_ids) && JSON.stringify(b.users_ids) === '[305,150]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '150',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        project_id: number;
        removed_by: string;
        users_ids?: number[];
        users_emails?: string[];
        count: number;
      };
    };
    expect(env.schema).toBe('freelo.projects.workers.remove/v1');
    expect(env.data.project_id).toBe(9001);
    expect(env.data.removed_by).toBe('ids');
    expect(env.data.users_ids).toEqual([305, 150]);
    expect(env.data.users_emails).toBeUndefined();
    expect(env.data.count).toBe(2);
  });

  it('duplicate --user values are deduplicated first-seen-wins', async () => {
    server.use(
      projectsWorkersHandlers.removeByIdsOkWhenBody(9001, (body) => {
        const b = body as { users_ids?: unknown };
        return JSON.stringify(b.users_ids) === '[305,150]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '305',
      '--user',
      '150',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { count: number; users_ids: number[] };
    };
    expect(env.data.users_ids).toEqual([305, 150]);
    expect(env.data.count).toBe(2);
  });

  it('single --user --yes → wire body has one id, count: 1', async () => {
    server.use(
      projectsWorkersHandlers.removeByIdsOkWhenBody(9001, (body) => {
        const b = body as { users_ids?: unknown };
        return JSON.stringify(b.users_ids) === '[305]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { count: number } };
    expect(env.data.count).toBe(1);
  });

  it('human mode renders the success line', async () => {
    server.use(projectsWorkersHandlers.removeByIdsOk(9001));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '150',
      '--yes',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Removed 2 workers from project #9001 (by ids).');
  });
});

// ---------------------------------------------------------------------------
//  Happy paths — by-emails
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — by emails', () => {
  it('--email a@x.io --email b@y.io --yes → success envelope, body assertion', async () => {
    server.use(
      projectsWorkersHandlers.removeByEmailsOkWhenBody(9001, (body) => {
        const b = body as { users_emails?: unknown };
        return JSON.stringify(b.users_emails) === '["a@x.io","b@y.io"]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--email',
      'b@y.io',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { removed_by: string; users_emails?: string[]; users_ids?: unknown; count: number };
    };
    expect(env.data.removed_by).toBe('emails');
    expect(env.data.users_emails).toEqual(['a@x.io', 'b@y.io']);
    expect(env.data.users_ids).toBeUndefined();
    expect(env.data.count).toBe(2);
  });

  it('duplicate --email values are deduplicated', async () => {
    server.use(
      projectsWorkersHandlers.removeByEmailsOkWhenBody(9001, (body) => {
        const b = body as { users_emails?: unknown };
        return JSON.stringify(b.users_emails) === '["a@x.io","b@y.io"]';
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--email',
      'a@x.io',
      '--email',
      'b@y.io',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { users_emails: string[]; count: number } };
    expect(env.data.users_emails).toEqual(['a@x.io', 'b@y.io']);
    expect(env.data.count).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — dry-run', () => {
  it('--dry-run by ids: no HTTP, no confirm; envelope has dry_run + would', async () => {
    // No MSW handler — assert no HTTP fired.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
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
      schema: string;
      dry_run: boolean;
      data: {
        project_id: number;
        removed_by: string;
        users_ids?: number[];
        count: number;
        would: { method: string; path: string; body: { users_ids?: number[] } };
      };
    };
    expect(env.schema).toBe('freelo.projects.workers.remove/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.removed_by).toBe('ids');
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/project/9001/remove-workers/by-ids');
    expect(env.data.would.body).toEqual({ users_ids: [305, 150] });
  });

  it('--dry-run by emails: would.path uses the by-emails endpoint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
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
      data: { would: { path: string; body: { users_emails?: string[] } } };
    };
    expect(env.data.would.path).toBe('/project/9001/remove-workers/by-emails');
    expect(env.data.would.body).toEqual({ users_emails: ['a@x.io'] });
  });

  it('--dry-run skips the confirmation prompt (non-TTY without --yes)', async () => {
    // No MSW handler. If a prompt or HTTP fires, the test fails.
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });

  it('human dry-run renders "(dry-run) Would remove ..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--user',
      '150',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would remove 2 workers from project #9001 (by ids).');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation gate
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — confirmation', () => {
  it('non-TTY without --yes → exit 2 (CONFIRMATION_REQUIRED), no HTTP', async () => {
    // No MSW handler.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toMatch(/CONFIRMATION_REQUIRED|--yes/);
  });

  it('confirmation copy mentions remove + project id + immediate-loss-of-access in TTY mode', async () => {
    // Calibration §7: clear CI so isInteractive() returns true under the
    // spoofed isTTY flags.
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
        'projects',
        'workers',
        'remove',
        '--project',
        '9001',
        '--user',
        '305',
        '--user',
        '150',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(captured).toContain('Remove 2 workers');
      expect(captured).toContain('#9001');
      expect(captured).toContain('lose access');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY user accepts → POST fires, exit 0', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(true),
    }));

    try {
      server.use(projectsWorkersHandlers.removeByIdsOk(9001));
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'projects',
        'workers',
        'remove',
        '--project',
        '9001',
        '--user',
        '305',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY user declines → exit 2, no HTTP', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockResolvedValue(false),
    }));

    try {
      // No MSW handler — if a request escapes, it fails.
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'projects',
        'workers',
        'remove',
        '--project',
        '9001',
        '--user',
        '305',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — validation', () => {
  it('--project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '0',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      'abc',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('neither --user nor --email → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toMatch(/--user|--email/);
  });

  it('both --user and --email → exit 2 (mutex)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--email',
      'a@x.io',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr.toLowerCase()).toContain('mutually exclusive');
  });

  it('--user 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '0',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--user abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      'abc',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--email "not-an-email" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--email',
      'not-an-email',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  API errors — calibration §2 + §4 (rewrite hint coverage)
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — API errors', () => {
  it('400 with "owner" mention → owner-flavored hint, exit 4 (calibration §4)', async () => {
    server.use(
      projectsWorkersHandlers.removeByIdsBadRequest(
        9001,
        'Project owner cannot be removed via this endpoint.',
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(400);
    expect(env.error.hint_next?.toLowerCase()).toContain('owner');
  });

  it('400 generic (no owner mention) → workers-list hint, exit 4', async () => {
    server.use(projectsWorkersHandlers.removeByIdsBadRequest(9001, 'Bad request.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(400);
    expect(env.error.hint_next).toMatch(/projects workers list/i);
  });

  it('400 by-emails (no owner mention) → email-pre-check-flavored hint, exit 4', async () => {
    server.use(projectsWorkersHandlers.removeByEmailsBadRequest(9001, 'Bad request.'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { hint_next?: string };
    };
    expect(env.error.hint_next).toMatch(/email|pre-check/i);
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(projectsWorkersHandlers.removeByIdsUnauthorized(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → permission hint, exit 4 (calibration §4)', async () => {
    server.use(projectsWorkersHandlers.removeByIdsForbidden(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('permission');
  });

  it('404 → project-not-found hint, exit 4 (calibration §4)', async () => {
    server.use(projectsWorkersHandlers.removeByIdsNotFound(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string } };
    expect(env.error.hint_next?.toLowerCase()).toContain('not found');
  });

  it('422 (email-not-in-project) → exit 4', async () => {
    server.use(projectsWorkersHandlers.removeByEmailsUnprocessable(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--email',
      'a@x.io',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(projectsWorkersHandlers.removeByIdsRateLimited(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });

  it('500 → SERVER_ERROR, exit 4', async () => {
    server.use(projectsWorkersHandlers.removeByIdsServerError(9001, 500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network error → NETWORK_ERROR, exit 5', async () => {
    server.use(projectsWorkersHandlers.removeByIdsNetworkError(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'remove',
      '--project',
      '9001',
      '--user',
      '305',
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects workers remove — introspection', () => {
  it('--introspect lists `projects workers remove` with destructive=true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: { name: string; output_schema: string; destructive: boolean }[];
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects workers remove');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.workers.remove/v1');
    expect(cmd?.destructive).toBe(true);
  });
});
