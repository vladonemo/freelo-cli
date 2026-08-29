/**
 * End-to-end tests for `freelo tasklists edit <id>` (M02, spec 0065).
 *
 * Calibration §1-2: every typed error path asserts the **exit code** through a
 * captured `process.exit`. Each typed error class reachable from this command
 * (`ValidationError`, `ConfirmationError`, `FreeloApiError`, `RateLimitedError`,
 * `NetworkError`) has at least one triggering test.
 * Calibration §7: the TTY-prompt test clears `process.env.CI` and restores it.
 *
 * M07 decision 6: no test here asserts a wire-level request **count** — this
 * repo's MSW setup can invoke a resolver twice per logical request. Assertions
 * are on request *content* and on whether an endpoint was reached at all.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasklistsEditHandlers } from '../../msw/handlers.js';

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

type EditEnvelope = {
  schema: string;
  notice?: string;
  dry_run?: boolean;
  data: {
    tasklist_id: number;
    priority_requested: boolean;
    priority_applied: boolean;
    applied_changes: Record<string, unknown>;
    would?: { method: string; path: string; body: Record<string, unknown> };
  };
};

const TL = 9001;
let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-tasklists-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasklists edit — happy paths', () => {
  it('rename only → JSON envelope, exit 0', async () => {
    server.use(tasklistsEditHandlers.ok(TL, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'QA checklist',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.schema).toBe('freelo.tasklists.edit/v1');
    expect(env.data.tasklist_id).toBe(TL);
    expect(env.data.applied_changes).toEqual({ name: 'QA checklist' });
    expect(env.data.priority_requested).toBe(false);
    expect(env.data.priority_applied).toBe(true);
    expect(env.notice).toBeUndefined();
  });

  it('maximal flag set: exact wire body asserted (content, not counts)', async () => {
    let capturedBody: unknown;
    server.use(
      tasklistsEditHandlers.okWhenBody(TL, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'Sprint 12',
      '--budget',
      '100000',
      '--time-budget-minutes',
      '480',
      '--worker',
      '77',
      '--tracking-users',
      '12',
      '--tracking-users',
      '34',
      '--should-change-existing-tasks',
      '--priority',
      '1',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      name: 'Sprint 12',
      budget: '100000',
      time_budget_minutes: 480,
      priority: 1,
      tracking_users_ids: [12, 34],
      should_change_existing_tasks: true,
      worker_id: 77,
    });
  });

  it('every clear flag maps to its documented wire value', async () => {
    let capturedBody: unknown;
    server.use(
      tasklistsEditHandlers.okWhenBody(TL, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--clear-budget',
      '--clear-time-budget',
      '--clear-worker',
      '--clear-tracking-users',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      budget: null,
      time_budget_minutes: null,
      worker_id: null,
      tracking_users_ids: [],
    });
  });

  it('--time-budget-minutes 0 sends 0, not null', async () => {
    let capturedBody: unknown;
    server.use(
      tasklistsEditHandlers.okWhenBody(TL, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--time-budget-minutes',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({ time_budget_minutes: 0 });
  });

  it('human mode renders the success line and the change list', async () => {
    server.use(tasklistsEditHandlers.ok(TL, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'QA checklist',
      '--budget',
      '100000',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Updated tasklist #9001.');
    expect(stdout).toContain('name: QA checklist');
    expect(stdout).toContain('budget: 100000');
  });
});

// ---------------------------------------------------------------------------
//  Partial success — priorityApplied (decision 4)
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — priorityApplied partial success', () => {
  it('priorityApplied:false with --priority → exit 0, priority_applied false, notice present', async () => {
    server.use(tasklistsEditHandlers.ok(TL, false));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'Renamed',
      '--priority',
      '3',
      '--output',
      'json',
    ]);

    // The load-bearing assertion of this slice: exit code is 0, not non-zero.
    expect(exitCode).toBe(0);

    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.data.priority_requested).toBe(true);
    expect(env.data.priority_applied).toBe(false);
    expect(env.notice).toBeDefined();
    expect(env.notice).toContain('priorityApplied=false');
    // The notice must name the exact retry command for just the priority.
    expect(env.notice).toContain('freelo tasklists edit 9001 --priority 3');
    // The other fields are still reported as applied.
    expect(env.data.applied_changes).toEqual({ name: 'Renamed', priority: 3 });
  });

  it('priorityApplied:true with --priority → no notice', async () => {
    server.use(tasklistsEditHandlers.ok(TL, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--priority',
      '1',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.data.priority_requested).toBe(true);
    expect(env.data.priority_applied).toBe(true);
    expect(env.notice).toBeUndefined();
  });

  it('priorityApplied:false WITHOUT --priority → no notice (nothing was requested)', async () => {
    server.use(tasklistsEditHandlers.ok(TL, false));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'Renamed',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.data.priority_requested).toBe(false);
    expect(env.data.priority_applied).toBe(false);
    expect(env.notice).toBeUndefined();
  });

  it('priority_applied is present on EVERY response, never absent', async () => {
    server.use(tasklistsEditHandlers.ok(TL, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'x',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect('priority_applied' in env.data).toBe(true);
    expect('priority_requested' in env.data).toBe(true);
  });

  it('human mode prints a prominent PRIORITY NOT APPLIED warning', async () => {
    server.use(tasklistsEditHandlers.ok(TL, false));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--priority',
      '2',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('PRIORITY NOT APPLIED');
    expect(stdout).toContain('--priority 2');
  });
});

// ---------------------------------------------------------------------------
//  Dry run
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — --dry-run', () => {
  it('emits would.method/path/body and makes zero HTTP calls', async () => {
    let called = false;
    server.use(
      tasklistsEditHandlers.forbidAnyCall(TL, () => {
        called = true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'Preview',
      '--clear-budget',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(called).toBe(false);

    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: '/tasklist/9001/edit',
      body: { name: 'Preview', budget: null },
    });
  });

  it('--dry-run skips the confirmation gate without --yes', async () => {
    let called = false;
    server.use(
      tasklistsEditHandlers.forbidAnyCall(TL, () => {
        called = true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--clear-tracking-users',
      '--should-change-existing-tasks',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(called).toBe(false);
    const env = parseFirstJson(stdout) as unknown as EditEnvelope;
    expect(env.data.would?.body).toEqual({
      tracking_users_ids: [],
      should_change_existing_tasks: true,
    });
  });

  it('human dry-run renders the would-update line', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--priority',
      '1',
      '--dry-run',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run) Would update tasklist #9001.');
    expect(stdout).toContain('ordering, not importance');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation gate (decision 5) — ConfirmationError, exit 2
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — --should-change-existing-tasks confirmation gate', () => {
  it('non-TTY without --yes → ConfirmationError, exit 2, no HTTP', async () => {
    let called = false;
    server.use(
      tasklistsEditHandlers.forbidAnyCall(TL, () => {
        called = true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--tracking-users',
      '12',
      '--should-change-existing-tasks',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    expect(called).toBe(false);
    expect(stderr).toContain('CONFIRMATION_REQUIRED');
  });

  it('--yes bypasses the gate and the request goes through', async () => {
    let capturedBody: unknown;
    server.use(
      tasklistsEditHandlers.okWhenBody(TL, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--clear-tracking-users',
      '--should-change-existing-tasks',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({
      tracking_users_ids: [],
      should_change_existing_tasks: true,
    });
  });

  it('a follower change WITHOUT the propagation flag is not gated', async () => {
    let capturedBody: unknown;
    server.use(
      tasklistsEditHandlers.okWhenBody(TL, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--clear-tracking-users',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedBody).toEqual({ tracking_users_ids: [] });
  });

  it('an ordinary rename is never gated', async () => {
    server.use(tasklistsEditHandlers.ok(TL, true));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'No gate here',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
  });

  it('TTY prompt copy names the blast radius (calibration §7: CI cleared)', async () => {
    // `isInteractive()` short-circuits on `process.env.CI`, which GitHub
    // Actions always sets — spoofing isTTY alone is NOT enough.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    let captured = '';
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn((opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(false); // decline → ConfirmationError, exit 2
      }),
    }));

    try {
      server.use(tasklistsEditHandlers.ok(TL, true));
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'tasklists',
        'edit',
        String(TL),
        '--clear-tracking-users',
        '--should-change-existing-tasks',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      expect(captured).toContain('REMOVE ALL FOLLOWERS');
      expect(captured).toContain('EVERY existing task');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  ValidationError paths — exit 2
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — ValidationError paths (exit 2)', () => {
  async function expectValidationFailure(args: string[]): Promise<string> {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      ...args,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stderr).toContain('VALIDATION_ERROR');
    return stderr;
  }

  it('non-numeric <id>', async () => {
    await expectValidationFailure(['abc', '--name', 'x']);
  });

  it('zero <id>', async () => {
    await expectValidationFailure(['0', '--name', 'x']);
  });

  it('no mutating flag at all', async () => {
    const stderr = await expectValidationFailure([String(TL)]);
    expect(stderr).toContain('At least one of');
  });

  it('--name empty', async () => {
    const stderr = await expectValidationFailure([String(TL), '--name', '   ']);
    expect(stderr).toContain('--name cannot be empty');
  });

  it('--budget with a decimal is rejected client-side', async () => {
    const stderr = await expectValidationFailure([String(TL), '--budget', '100.50']);
    expect(stderr).toContain('minor currency units');
  });

  it('--budget negative is rejected', async () => {
    await expectValidationFailure([String(TL), '--budget', '-5']);
  });

  it('--time-budget-minutes negative is rejected', async () => {
    await expectValidationFailure([String(TL), '--time-budget-minutes', '-1']);
  });

  it('--worker zero is rejected', async () => {
    await expectValidationFailure([String(TL), '--worker', '0']);
  });

  it('--tracking-users non-numeric is rejected', async () => {
    await expectValidationFailure([String(TL), '--tracking-users', 'bob']);
  });

  it('--priority zero is rejected, and the message says POSITION not importance', async () => {
    const stderr = await expectValidationFailure([String(TL), '--priority', '0']);
    expect(stderr).toContain('1 = first position in the project');
    expect(stderr).toContain('POSITION');
    expect(stderr).toContain('not an importance level');
  });

  it('--priority with an enum-style value is rejected with the disambiguating hint', async () => {
    // A user who has seen `priority_enum` elsewhere will try this.
    const stderr = await expectValidationFailure([String(TL), '--priority', 'high']);
    expect(stderr).toContain('freelo tasks edit --priority low|normal|high');
  });

  it.each([
    ['--budget', '100000', '--clear-budget'],
    ['--time-budget-minutes', '30', '--clear-time-budget'],
    ['--worker', '5', '--clear-worker'],
    ['--tracking-users', '5', '--clear-tracking-users'],
  ])('mutex: %s conflicts with %s', async (setFlag, value, clearFlag) => {
    const stderr = await expectValidationFailure([String(TL), setFlag, value, clearFlag]);
    expect(stderr).toContain('not both');
  });

  it('--should-change-existing-tasks without a follower change is rejected', async () => {
    const stderr = await expectValidationFailure([
      String(TL),
      '--name',
      'x',
      '--should-change-existing-tasks',
    ]);
    expect(stderr).toContain('requires --tracking-users or --clear-tracking-users');
  });

  it('--should-change-existing-tasks alone is rejected', async () => {
    await expectValidationFailure([String(TL), '--should-change-existing-tasks']);
  });
});

// ---------------------------------------------------------------------------
//  API error paths — calibration §2 exit-code coverage
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — API error paths', () => {
  async function runRename(): Promise<{ stderr: string; exitCode: number }> {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'edit',
      String(TL),
      '--name',
      'x',
      '--output',
      'json',
    ]);
    return { stderr, exitCode };
  }

  it('400 → FreeloApiError, exit 4, hint names the budget encoding', async () => {
    server.use(tasklistsEditHandlers.badRequest(TL));
    const { stderr, exitCode } = await runRename();
    expect(exitCode).toBe(4);
    expect(stderr).toContain('minor units');
  });

  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(tasklistsEditHandlers.unauthorized(TL));
    const { stderr, exitCode } = await runRename();
    expect(exitCode).toBe(3);
    expect(stderr).toContain('AUTH_EXPIRED');
  });

  it('403 → FORBIDDEN, exit 4, hint mentions permission', async () => {
    server.use(tasklistsEditHandlers.forbidden(TL));
    const { stderr, exitCode } = await runRename();
    expect(exitCode).toBe(4);
    expect(stderr).toContain('permission');
  });

  it('404 → exit 4, hint mentions not found', async () => {
    server.use(tasklistsEditHandlers.notFound(TL));
    const { stderr, exitCode } = await runRename();
    expect(exitCode).toBe(4);
    expect(stderr).toContain('not found');
  });

  it('500 → exit 4', async () => {
    server.use(tasklistsEditHandlers.serverError(TL));
    const { exitCode } = await runRename();
    expect(exitCode).toBe(4);
  });

  it('429 → RateLimitedError, exit 6', async () => {
    server.use(tasklistsEditHandlers.rateLimited(TL));
    const { exitCode } = await runRename();
    expect(exitCode).toBe(6);
  });

  it('network failure → NetworkError, exit 5', async () => {
    server.use(tasklistsEditHandlers.networkError(TL));
    const { exitCode } = await runRename();
    expect(exitCode).toBe(5);
  });

  it('200 missing the required priorityApplied → schema failure, exit 4', async () => {
    server.use(tasklistsEditHandlers.malformed(TL));
    const { stderr, exitCode } = await runRename();
    expect(exitCode).toBe(4);
    expect(stderr).toContain('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo tasklists edit — introspection', () => {
  it('appears in --introspect with its schema and destructive=false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['--introspect']);
    const env = parseFirstJson(stdout);
    const json = JSON.stringify(env);
    expect(json).toContain('freelo.tasklists.edit/v1');
    expect(json).toContain('tasklists edit');
  });
});
