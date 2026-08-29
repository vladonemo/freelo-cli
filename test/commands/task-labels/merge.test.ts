/**
 * End-to-end tests for `freelo task-labels merge` (M06, spec 0068).
 *
 * The command is the most destructive surface in the CLI — an irreversible
 * bulk relabel with no undo endpoint — so the suite is weighted towards the
 * three things that keep it safe rather than towards the happy path:
 *
 *   1. **The confirmation gate.** Non-TTY without `--yes` fails closed before
 *      any request; TTY decline aborts with zero requests; `--dry-run` skips
 *      both the prompt and the wire.
 *   2. **Input validation**, all of it exit 2 — including the self-merge and
 *      case-differing-duplicate edges the server contract does not define.
 *   3. **Envelope honesty.** Pinned absences (`tasks_updated`,
 *      `tasks_skipped`, `already_in_target_state`) so a later "make the write
 *      commands consistent" refactor fails loudly instead of quietly
 *      fabricating a count the API never returned (spec 0068 §D1).
 *
 * Calibration §2: every error path the spec assigns an exit code asserts that
 * exit code, and each typed error class reachable here has a triggering test
 * (`ValidationError` 2, `ConfirmationError` 2, `FreeloApiError` 401/403/404/5xx,
 * `RateLimitedError` 6, `NetworkError` 5).
 * Calibration §7: every TTY-prompt test clears `process.env.CI` and restores it
 * in `finally`.
 * Repo caution: MSW resolvers can fire twice per logical request, so body
 * assertions inspect captured *content*, never a request count.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';
import { renderTaskLabelsMergeHuman } from '../../../src/ui/human/task-labels-merge.js';
import { mergeConfirmMessage, dedupeUuids } from '../../../src/commands/task-labels/merge.js';

const FROM_A = '0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const FROM_B = '1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const FROM_C = '2f2f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f';
const TO = '9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f';

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
      /* try next */
    }
  }
  throw new Error(`No JSON in: ${text.slice(0, 200)}`);
}

type MergeEnvelope = {
  schema: string;
  dry_run?: boolean;
  data: {
    to_uuid: string;
    from_uuids: string[];
    count: number;
    scope: string;
    would?: { method: string; path: string; body?: unknown };
  };
  rate_limit?: { remaining: number | null; reset_at: string | null };
};

type ErrorEnvelope = {
  schema: string;
  error: {
    code: string;
    message: string;
    errors?: string[];
    http_status: number | null;
    retryable: boolean;
    hint_next: string | null;
  };
};

let testDir: string;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  // Pay the module-transform cost once, outside any test's timeout — see
  // `test/commands/taskchecks/harness.ts` `warmUpCli`.
  await import('../../../src/bin/freelo.js');
}, 60_000);

afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-tl-merge-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  // Default: non-TTY (the agent path). Tests needing TTY mock it explicitly
  // AND clear `CI` — calibration §7.
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

// ---------------------------------------------------------------------------
//  Unit: pure helpers (no CLI round-trip, no isInteractive() in the picture)
// ---------------------------------------------------------------------------

describe('mergeConfirmMessage', () => {
  it('singular copy names the irreversibility', () => {
    const msg = mergeConfirmMessage(1, TO);
    expect(msg).toBe(
      `Merge 1 label into ${TO}? Every task carrying it is relabeled. This cannot be undone.`,
    );
  });

  it('plural copy names the count and the irreversibility', () => {
    const msg = mergeConfirmMessage(3, TO);
    expect(msg).toBe(
      `Merge 3 labels into ${TO}? Every task carrying them is relabeled. This cannot be undone.`,
    );
  });
});

describe('dedupeUuids', () => {
  it('preserves input order and the first spelling seen', () => {
    expect(dedupeUuids([FROM_B, FROM_A, FROM_B])).toEqual([FROM_B, FROM_A]);
  });

  it('treats uuids differing only in hex case as the same label', () => {
    expect(dedupeUuids([FROM_A, FROM_A.toUpperCase()])).toEqual([FROM_A]);
  });
});

describe('renderTaskLabelsMergeHuman', () => {
  const base = {
    to_uuid: TO,
    from_uuids: [FROM_A, FROM_B],
    count: 2,
    scope: 'commander_projects' as const,
  };

  it('live success states the count and both contract caveats', () => {
    const out = renderTaskLabelsMergeHuman(base);
    expect(out.split('\n')[0]).toBe(`Merged 2 labels into ${TO}.`);
    expect(out).toContain('commander');
    expect(out).toContain('no per-task detail');
    expect(out).toContain('source label definitions still exist');
  });

  it('dry-run branch is prefixed, conditional, and keeps the caveats', () => {
    const out = renderTaskLabelsMergeHuman({
      ...base,
      would: { method: 'POST', path: '/task-labels/merge', body: {} },
    });
    expect(out.split('\n')[0]).toBe(`(dry-run) Would merge 2 labels into ${TO}.`);
    expect(out).toContain('commander');
  });

  it('singular count uses the singular noun', () => {
    const out = renderTaskLabelsMergeHuman({ ...base, from_uuids: [FROM_A], count: 1 });
    expect(out.split('\n')[0]).toBe(`Merged 1 label into ${TO}.`);
  });
});

// ---------------------------------------------------------------------------
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — happy paths', () => {
  it('single --from with --yes: JSON envelope, exit 0', async () => {
    server.use(taskLabelsHandlers.mergeOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.schema).toBe('freelo.task_labels.merge/v1');
    expect(env.data.to_uuid).toBe(TO);
    expect(env.data.from_uuids).toEqual([FROM_A]);
    expect(env.data.count).toBe(1);
    expect(env.dry_run).toBeUndefined();
  });

  it('repeated --from sends every source in one call, in input order', async () => {
    const captured: unknown[] = [];
    server.use(taskLabelsHandlers.mergeOkCapturing(captured));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--from',
      FROM_B,
      '--from',
      FROM_C,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    // Content, never count — a resolver can fire twice per logical request.
    expect(captured[0]).toEqual({ from_uuids: [FROM_A, FROM_B, FROM_C], to_uuid: TO });
    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.data.count).toBe(3);
  });

  it('one --from carrying a comma-separated list is equivalent to repeating it', async () => {
    const captured: unknown[] = [];
    server.use(taskLabelsHandlers.mergeOkCapturing(captured));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      `${FROM_A},${FROM_B}`,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured[0]).toEqual({ from_uuids: [FROM_A, FROM_B], to_uuid: TO });
  });

  it('duplicate sources are de-duplicated before the wire call', async () => {
    const captured: unknown[] = [];
    server.use(taskLabelsHandlers.mergeOkCapturing(captured));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--from',
      FROM_A.toUpperCase(),
      '--from',
      FROM_B,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(captured[0]).toEqual({ from_uuids: [FROM_A, FROM_B], to_uuid: TO });
    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.data.count).toBe(2);
  });

  it('human output carries the scope caveat', async () => {
    server.use(taskLabelsHandlers.mergeOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Merged 1 label into ${TO}.`);
    expect(stdout).toContain('commander');
  });
});

// ---------------------------------------------------------------------------
//  Envelope honesty — the load-bearing absences (spec 0068 §D1 / §D1b)
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — envelope honesty', () => {
  it('never reports a task count the API does not return', async () => {
    server.use(taskLabelsHandlers.mergeOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.data).not.toHaveProperty('tasks_updated');
    expect(env.data).not.toHaveProperty('tasks_skipped');
    expect(env.data).not.toHaveProperty('already_in_target_state');
    expect(env.data).not.toHaveProperty('previous_state');
  });

  it('carries the constant scope marker so a JSON consumer cannot read success as completeness', async () => {
    server.use(taskLabelsHandlers.mergeOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.data.scope).toBe('commander_projects');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — dry-run', () => {
  it('makes no request and echoes the body that would have been sent', async () => {
    // No handler registered: `onUnhandledRequest: 'error'` turns any request
    // into a failure, so a passing test proves the wire was never touched.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--from',
      FROM_B,
      '--to',
      TO,
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as MergeEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would?.method).toBe('POST');
    expect(env.data.would?.path).toBe('/task-labels/merge');
    expect(env.data.would?.body).toEqual({ from_uuids: [FROM_A, FROM_B], to_uuid: TO });
  });

  it('skips the confirmation prompt entirely (non-TTY, no --yes, still exit 0)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
  });

  it('dry-run rejects invalid input before anything else', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      FROM_A,
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Confirmation gate (spec 0068 §5.1)
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — confirmation gate', () => {
  it('non-TTY without --yes → CONFIRMATION_REQUIRED, exit 2, no request', async () => {
    // No handler registered — any wire call would fail the test.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
    expect(env.error.message).toContain('cannot be undone');
  });

  it('TTY + user declines → exit 2, no request', async () => {
    // Calibration §7: GitHub Actions sets CI=true, which makes isInteractive()
    // return false regardless of isTTY — clear it so the prompt branch runs.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const confirmMock = vi.fn().mockResolvedValue(false);
    vi.doMock('@inquirer/prompts', () => ({ confirm: confirmMock }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'task-labels',
        'merge',
        '--from',
        FROM_A,
        '--to',
        TO,
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      expect(confirmMock).toHaveBeenCalled();
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY + user accepts → proceeds, exit 0, and the prompt names the target', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    const captured: string[] = [];
    vi.doMock('@inquirer/prompts', () => ({
      confirm: vi.fn().mockImplementation((opts: { message: string }) => {
        captured.push(opts.message);
        return Promise.resolve(true);
      }),
    }));
    server.use(taskLabelsHandlers.mergeOk());

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'task-labels',
        'merge',
        '--from',
        FROM_A,
        '--from',
        FROM_B,
        '--to',
        TO,
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(0);
      expect(captured.join('\n')).toContain(`Merge 2 labels into ${TO}?`);
      expect(captured.join('\n')).toContain('cannot be undone');
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

// ---------------------------------------------------------------------------
//  Validation — every branch exits 2 (calibration §2)
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — validation', () => {
  async function expectValidationExit2(args: string[]): Promise<ErrorEnvelope> {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      ...args,
      '--yes',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    return parseFirstJson(stdout + stderr) as ErrorEnvelope;
  }

  it('missing --to → VALIDATION_ERROR exit 2 (not Commander exit 1)', async () => {
    const env = await expectValidationExit2(['--from', FROM_A]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--to is required');
  });

  it('missing --from → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--from is required');
  });

  it('malformed --from uuid → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--from', 'not-a-uuid', '--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--from must be a UUID');
  });

  it('malformed --to uuid → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--from', FROM_A, '--to', '123']);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--to must be a UUID');
  });

  it('one bad uuid inside a comma list → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--from', `${FROM_A},nope`, '--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--from must be a UUID');
  });

  it('empty --from value → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--from', '  ', '--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--from requires at least one UUID');
  });

  it('self-merge (--to also in --from) → VALIDATION_ERROR exit 2', async () => {
    const env = await expectValidationExit2(['--from', FROM_A, '--from', TO, '--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--to must not also appear in --from');
  });

  it('self-merge differing only in hex case is still rejected', async () => {
    const env = await expectValidationExit2(['--from', TO.toUpperCase(), '--to', TO]);
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('--to must not also appear in --from');
  });

  it('validation runs before the confirmation gate (non-TTY, no --yes, bad uuid → exit 2 as VALIDATION_ERROR)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'merge',
      '--from',
      'garbage',
      '--to',
      TO,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Error surface (spec 0068 §5.2)
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — error surface', () => {
  async function runMerge(): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    const { run } = await import('../../../src/bin/freelo.js');
    return runCli(run, [
      'task-labels',
      'merge',
      '--from',
      FROM_A,
      '--to',
      TO,
      '--yes',
      '--output',
      'json',
    ]);
  }

  it('404 is an ERROR, never absorbed into an idempotent success', async () => {
    server.use(taskLabelsHandlers.mergeNotFound());
    const { stdout, stderr, exitCode } = await runMerge();

    // The regression this pins: a future "make the writes consistent" change
    // that routes this through `src/lib/idempotency.ts` would turn a merge
    // that never happened into exit 0. Spec 0068 §5.2.
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.http_status).toBe(404);
    expect(env.error.message).toBe('One or more of the labels was not found.');
  });

  it('404 message stays plain; the ownership nuance lives in hint_next', async () => {
    server.use(taskLabelsHandlers.mergeNotFound());
    const { stdout, stderr } = await runMerge();

    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    // The CLI cannot tell "missing" from "not yours", so it claims neither.
    expect(env.error.message).not.toMatch(/permission|forbidden|owned/i);
    expect(env.error.hint_next).toContain('owned by you');
    expect(env.error.hint_next).toContain('404 rather than 403');
    expect(env.error.hint_next).toContain('freelo task-labels find');
    // ...and admits `find` is a superset, not a pre-flight check (§2.3).
    expect(env.error.hint_next).toContain('superset');
  });

  it('401 → exit 3', async () => {
    server.use(taskLabelsHandlers.mergeUnauthorized());
    const { exitCode } = await runMerge();
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4, message untouched (no rewrite branch for 403)', async () => {
    server.use(taskLabelsHandlers.mergeForbidden());
    const { stdout, stderr, exitCode } = await runMerge();
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.message).not.toBe('One or more of the labels was not found.');
  });

  it('500 → exit 4, passes through unrewritten', async () => {
    server.use(taskLabelsHandlers.mergeServerError());
    const { stdout, stderr, exitCode } = await runMerge();
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout + stderr) as ErrorEnvelope;
    expect(env.error.http_status).toBe(500);
    expect(env.error.message).not.toBe('One or more of the labels was not found.');
  });

  it('429 → RateLimitedError, exit 6', async () => {
    server.use(taskLabelsHandlers.mergeRateLimited());
    const { exitCode } = await runMerge();
    expect(exitCode).toBe(6);
  });

  it('network failure → NetworkError, exit 5', async () => {
    server.use(taskLabelsHandlers.mergeNetworkError());
    const { exitCode } = await runMerge();
    expect(exitCode).toBe(5);
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo task-labels merge — introspect', () => {
  it('shows in --introspect with output_schema and destructive: true', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const merge = env.data.commands.find((c) => c.name === 'task-labels merge');
    expect(merge).toBeDefined();
    expect(merge?.output_schema).toBe('freelo.task_labels.merge/v1');
    expect(merge?.destructive).toBe(true);
  });
});
