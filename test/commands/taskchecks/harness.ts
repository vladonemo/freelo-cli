/**
 * Shared test harness for the `freelo taskchecks` family (M03, spec 0066).
 *
 * Four subcommands share one bootstrap (env-var auth, non-TTY default, mocked
 * `conf`, stdout/stderr/exit capture). Duplicating ~90 lines of it four times
 * is how it drifts, so it lives here. Not collected by vitest — the `include`
 * glob is `test/**\/*.test.ts`.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { expect, vi } from 'vitest';

export type CapturedRun = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

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

export async function runCli(
  runFn: (argv: readonly string[]) => Promise<void>,
  args: string[],
): Promise<CapturedRun> {
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

export function parseFirstJson(text: string): Record<string, unknown> {
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

export function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

export function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  Object.defineProperty(process, 'stdin', { configurable: true, value: stream });
  return () => {
    Object.defineProperty(process, 'stdin', { configurable: true, value: original });
  };
}

export type TransitionEnvelope = {
  schema: string;
  dry_run?: boolean;
  data: {
    taskcheck_id: number;
    verb?: string;
    current_state: string;
    notify_author?: boolean;
    applied_changes?: string[];
    would?: { method: string; path: string; body?: unknown };
    line_index?: number;
  };
  rate_limit?: { remaining: number | null; reset_at: string | null };
};

export type ErrorEnvelope = {
  schema: string;
  error: {
    code: string;
    message: string;
    errors?: string[];
    http_status: number | null;
    retryable: boolean;
    hint_next: string | null;
    context?: Record<string, number | string>;
  };
};

/**
 * Pay the CLI's module-transform cost **once, outside any test's timeout**.
 *
 * Every test here does `await import('../../../src/bin/freelo.js')`, and
 * `setUpEach` calls `vi.resetModules()` so each one re-executes the graph. The
 * module *registry* resets, but vite's transform cache does not — so the first
 * import in a file pays the full compile (~10 s on a loaded machine) and every
 * later one is fast. Charging that one-off cost to whichever test happens to
 * run first made the first test in each file flake against the 15 s
 * `testTimeout` whenever the machine was busy.
 *
 * Call from `beforeAll` with a generous explicit timeout. This is a
 * timing-robustness fix, not a behavior change — no test's assertions depend
 * on it.
 */
export async function warmUpCli(): Promise<void> {
  await import('../../../src/bin/freelo.js');
}

let testDir: string;

export async function setUpEach(label: string): Promise<void> {
  testDir = join(tmpdir(), `freelo-${label}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
}

export async function tearDownEach(): Promise<void> {
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
}

/**
 * Assert the load-bearing absence from spec 0066 §5.2 / decision 5: taskcheck
 * envelopes never carry `previous_state` or `already_in_target_state`, because
 * a simple checklist item's prior state is unobservable (there is no
 * `GET /taskcheck/{id}`). Pinned so a future "make the write commands
 * consistent" refactor fails loudly rather than silently fabricating a value.
 */
export function expectNoStateObservationFields(data: Record<string, unknown>): void {
  expect(data).not.toHaveProperty('already_in_target_state');
  expect(data).not.toHaveProperty('previous_state');
}

/**
 * Assert the 404 hint carries the id-space escape hatch (decision 2/4): it must
 * name the `freelo tasks …` alternative and the `freelo subtasks list`
 * discovery path, while the *message* stays a plain not-found that never
 * asserts which of the three causes applied.
 */
export function expectIdSpaceHint(err: ErrorEnvelope['error'], smartAlternative: string): void {
  expect(err.message).toMatch(/^Taskcheck \d+ not found\.$/);
  expect(err.message).not.toMatch(/smart|permission|forbidden/i);
  expect(err.hint_next).toContain(`freelo ${smartAlternative}`);
  expect(err.hint_next).toContain('freelo subtasks list');
  expect(err.hint_next).toContain('type');
}
