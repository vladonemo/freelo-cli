/**
 * End-to-end tests for `freelo taskchecks delete <id>...` (M03, spec 0066).
 *
 * Covers the batch surfaces, the confirmation gate, `--dry-run`, and the two
 * load-bearing contracts:
 *
 *   - **404 is an error, never idempotent success** (§5.1 / decision 4), with
 *     an id-space `hint_next`. Regression-pinned so a later "let's make the
 *     deletes consistent" refactor fails loudly.
 *   - **No `notify_author` on the wire** (§2.1 / decision 3) — this operation
 *     declares no `requestBody`, so the command sends none and the flag does
 *     not exist.
 *
 * Calibration §2 (exit codes on every error path), §4 (each new catch arm has
 * a case), §7 (TTY-prompt tests clear `CI`). M07 decision 6: content, not counts.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskchecksHandlers } from '../../msw/handlers.js';
import {
  expectIdSpaceHint,
  expectNoStateObservationFields,
  parseAllJsonLines,
  parseFirstJson,
  pipeStdin,
  runCli,
  setUpEach,
  tearDownEach,
  warmUpCli,
  type ErrorEnvelope,
  type TransitionEnvelope,
} from './harness.js';

const A = 4821;
const B = 4822;
const MISSING = 9999;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  await warmUpCli();
}, 60_000);
afterAll(() => {
  server.close();
});
beforeEach(async () => {
  await setUpEach('taskchecks-delete');
});
afterEach(async () => {
  server.resetHandlers();
  await tearDownEach();
});

describe('freelo taskchecks delete — happy paths', () => {
  it('single id with --yes: envelope, derived current_state, exit 0', async () => {
    server.use(taskchecksHandlers.deleteOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.schema).toBe('freelo.taskchecks.delete/v1');
    expect(env.data.taskcheck_id).toBe(A);
    expect(env.data.current_state).toBe('deleted');
    expect(env).toHaveProperty('rate_limit');
  });

  it('sends NO request body — this operation declares none (decision 3)', async () => {
    let body: unknown = 'unset';
    server.use(taskchecksHandlers.deleteOk(A, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, ['taskchecks', 'delete', String(A), '--yes', '--output', 'json']);

    expect(body).toBeUndefined();
  });

  it('the envelope omits already_in_target_state / previous_state (decision 5)', async () => {
    server.use(taskchecksHandlers.deleteOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expectNoStateObservationFields(env.data as unknown as Record<string, unknown>);
  });

  it('single-id envelope carries no line_index', async () => {
    server.use(taskchecksHandlers.deleteOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--yes',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data).not.toHaveProperty('line_index');
  });

  it('multi positional emits one envelope per id', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200, [B]: 200 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      String(B),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as unknown as TransitionEnvelope[];
    expect(envs.map((e) => e.data.taskcheck_id)).toEqual([A, B]);
  });

  it('--ids accepts a comma-separated list', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200, [B]: 200 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      '--ids',
      `${A},${B}`,
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(parseAllJsonLines(stdout)).toHaveLength(2);
  });

  it('--stdin NDJSON tags each envelope with its line_index, in input order', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200, [B]: 200 }));
    const restore = pipeStdin(`{"id": ${A}}\n{"id": ${B}}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as unknown as TransitionEnvelope[];
      expect(envs.map((e) => e.data.line_index)).toEqual([0, 1]);
      expect(envs.map((e) => e.data.taskcheck_id)).toEqual([A, B]);
    } finally {
      restore();
    }
  });

  it('empty stdin is a silent success (exit 0, no prompt, no call)', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));
    const restore = pipeStdin('');

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      expect(called).toBe(false);
      expect(stdout.trim()).toBe('');
    } finally {
      restore();
    }
  });

  it('human output renders one line per id', async () => {
    server.use(taskchecksHandlers.deleteOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--yes',
      '--output',
      'human',
    ]);

    expect(stdout).toContain(`Deleted taskcheck ${A}.`);
  });
});

describe('freelo taskchecks delete — confirmation gate', () => {
  it('non-TTY without --yes → CONFIRMATION_REQUIRED exit 2, and no wire call', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    expect(called).toBe(false);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('CONFIRMATION_REQUIRED');
  });

  it('--dry-run needs neither --yes nor a prompt, and makes no call', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(called).toBe(false);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would).toEqual({ method: 'DELETE', path: `/taskcheck/${A}`, body: {} });
  });

  it('TTY prompt copy counts the items; declining → exit 2, no call', async () => {
    // Calibration §7: `isInteractive()` short-circuits on `CI`, which GitHub
    // Actions always sets — spoofing isTTY alone would silently take the
    // non-TTY branch and this assertion would vacuously pass.
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    let captured = '';
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));
    vi.doMock('@inquirer/prompts', () => ({
      confirm: (opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(false);
      },
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        String(A),
        String(B),
        '--output',
        'json',
      ]);

      expect(captured).toContain('2 checklist items');
      expect(exitCode).toBe(2);
      expect(called).toBe(false);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });

  it('TTY prompt uses the singular for one item', async () => {
    const savedCI = process.env['CI'];
    delete process.env['CI'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });

    let captured = '';
    server.use(taskchecksHandlers.deleteOk(A));
    vi.doMock('@inquirer/prompts', () => ({
      confirm: (opts: { message: string }) => {
        captured = opts.message;
        return Promise.resolve(true);
      },
    }));

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        String(A),
        '--output',
        'json',
      ]);

      expect(captured).toBe('Delete 1 checklist item?');
      expect(exitCode).toBe(0);
    } finally {
      if (savedCI !== undefined) process.env['CI'] = savedCI;
    }
  });
});

describe('freelo taskchecks delete — the 404 id-space contract (decision 4)', () => {
  it('404 is an ERROR (exit 4) and never an already-deleted success', async () => {
    server.use(taskchecksHandlers.deleteNotFound(MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(MISSING),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).not.toContain('freelo.taskchecks.delete/v1');
    expect(stdout).not.toContain('already');
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.http_status).toBe(404);
    expect(env.error.retryable).toBe(false);
    expectIdSpaceHint(env.error, 'tasks delete');
  });
});

describe('freelo taskchecks delete — batch error semantics', () => {
  it('mixed batch: per-item error envelope with input_index, highest exit code wins', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200, [MISSING]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      String(MISSING),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    const failure = lines[1] as unknown as ErrorEnvelope;
    expect(failure.schema).toBe('freelo.error/v1');
    expect(failure.error.context).toMatchObject({ input_index: 1, taskcheck_id: MISSING });
    expectIdSpaceHint(failure.error, 'tasks delete');
  });

  it('malformed NDJSON line reports line_index and does not stop the batch', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200 }));
    const restore = pipeStdin(`not json\n{"id": ${A}}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as unknown as ErrorEnvelope).error.context).toMatchObject({ line_index: 0 });
      expect((lines[1] as unknown as TransitionEnvelope).data.taskcheck_id).toBe(A);
    } finally {
      restore();
    }
  });

  it('NDJSON schema is strict — an unknown key is a per-line error', async () => {
    const restore = pipeStdin(`{"taskcheck_id": ${A}}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'delete',
        '--stdin',
        '--yes',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const line = parseFirstJson(stdout) as unknown as ErrorEnvelope;
      expect(line.schema).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });

  it('batch failures render as human lines when --output human', async () => {
    server.use(taskchecksHandlers.deleteMatrix({ [A]: 200, [MISSING]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      String(MISSING),
      '--yes',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain(`Deleted taskcheck ${A}.`);
    expect(stdout).toContain(`Failed item 2 (${MISSING}):`);
  });
});

describe('freelo taskchecks delete — input validation (exit 2)', () => {
  it('no input source at all', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/No taskcheck ids supplied/);
  });

  it('combining positional and --ids is rejected', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      String(A),
      '--ids',
      String(B),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    expect(parseFirstJson(stderr)).toBeTruthy();
  });

  it('combining --stdin and --ids is rejected', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      '--stdin',
      '--ids',
      String(B),
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.message).toMatch(/exactly one input source/);
  });

  it('a negative id in --ids is rejected (the positional form can not reach this)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      '--ids',
      '-3',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.message).toMatch(/--ids must be a positive integer/);
  });

  it('an all-whitespace --ids value is rejected', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'delete',
      '--ids',
      '   ',
      '--yes',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('freelo taskchecks delete — introspection', () => {
  it('is enumerated as destructive with its output schema', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['--introspect']);

    expect(stdout).toContain('freelo.taskchecks.delete/v1');
    expect(stdout).toContain('freelo.taskchecks.edit/v1');
    expect(stdout).toContain('freelo.taskchecks.finish/v1');
    expect(stdout).toContain('freelo.taskchecks.reopen/v1');
  });
});
