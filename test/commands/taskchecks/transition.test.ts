/**
 * End-to-end tests for `freelo taskchecks finish` and `freelo taskchecks reopen`
 * (M03, spec 0066).
 *
 * The two verbs share one implementation, so they share one suite. The
 * load-bearing assertions here are the two places this family deliberately
 * diverges from R11's `tasks finish`/`tasks reopen`:
 *
 *   - **No `already_in_target_state` / `previous_state`** anywhere (§5.2 /
 *     decision 5) — a simple checklist item's prior state is unobservable, so
 *     the CLI never claims it. Pinned so a "consistency" refactor fails loudly.
 *   - **`--notify-author` exists on `finish` but not on `reopen`** (§2.1 /
 *     decision 3), because `/activate` declares no request body.
 *
 * Also covers: verb → wire-path mapping (`reopen` → `/activate`), batch
 * surfaces, dry-run, the 404 id-space contract, and exit codes.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  await setUpEach('taskchecks-transition');
});
afterEach(async () => {
  server.resetHandlers();
  await tearDownEach();
});

describe('freelo taskchecks finish', () => {
  it('single id: envelope, verb, derived current_state, exit 0', async () => {
    server.use(taskchecksHandlers.finishOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.schema).toBe('freelo.taskchecks.finish/v1');
    expect(env.data.taskcheck_id).toBe(A);
    expect(env.data.verb).toBe('finish');
    expect(env.data.current_state).toBe('finished');
    expect(env.data.notify_author).toBe(false);
    expect(env).toHaveProperty('rate_limit');
  });

  it('omits already_in_target_state / previous_state (decision 5)', async () => {
    server.use(taskchecksHandlers.finishOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['taskchecks', 'finish', String(A), '--output', 'json']);

    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expectNoStateObservationFields(env.data as unknown as Record<string, unknown>);
  });

  it('sends no body by default — notify_author defaults to false server-side', async () => {
    let body: unknown = 'unset';
    server.use(taskchecksHandlers.finishOk(A, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, ['taskchecks', 'finish', String(A), '--output', 'json']);

    expect(body).toBeUndefined();
  });

  it('--notify-author sends { notify_author: true } (decision 3)', async () => {
    let body: unknown;
    server.use(taskchecksHandlers.finishOk(A, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      '--notify-author',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(body).toEqual({ notify_author: true });
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data.notify_author).toBe(true);
  });

  it('human output reads "Finished taskcheck <id>."', async () => {
    server.use(taskchecksHandlers.finishOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['taskchecks', 'finish', String(A), '--output', 'human']);

    expect(stdout).toContain(`Finished taskcheck ${A}.`);
  });
});

describe('freelo taskchecks reopen', () => {
  it('maps to the /activate wire path, not /reopen', async () => {
    // The handler is registered on /activate; if the command called /reopen the
    // request would be unhandled and MSW (onUnhandledRequest: 'error') fails it.
    server.use(taskchecksHandlers.activateOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'reopen',
      String(A),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.schema).toBe('freelo.taskchecks.reopen/v1');
    expect(env.data.verb).toBe('reopen');
    expect(env.data.current_state).toBe('active');
  });

  it('sends NO body — /activate declares no requestBody (decision 3)', async () => {
    let body: unknown = 'unset';
    server.use(taskchecksHandlers.activateOk(A, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    await runCli(run, ['taskchecks', 'reopen', String(A), '--output', 'json']);

    expect(body).toBeUndefined();
  });

  it('has no --notify-author flag at all — an unknown option exits non-zero', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'taskchecks',
      'reopen',
      String(A),
      '--notify-author',
      '--output',
      'json',
    ]);

    expect(exitCode).not.toBe(0);
  });

  it('dry-run echoes the /activate path with an empty body', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'reopen',
      String(A),
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(called).toBe(false);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.dry_run).toBe(true);
    expect(env.data.would).toEqual({
      method: 'POST',
      path: `/taskcheck/${A}/activate`,
      body: {},
    });
  });

  it('human output reads "Reopened taskcheck <id>."', async () => {
    server.use(taskchecksHandlers.activateOk(A));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, ['taskchecks', 'reopen', String(A), '--output', 'human']);

    expect(stdout).toContain(`Reopened taskcheck ${A}.`);
  });
});

describe('freelo taskchecks finish — dry run', () => {
  it('makes no call; --notify-author is reflected in the echoed body', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      '--notify-author',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(called).toBe(false);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data.would).toEqual({
      method: 'POST',
      path: `/taskcheck/${A}/finish`,
      body: { notify_author: true },
    });
  });

  it('dry-run resolves no credentials', async () => {
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(called).toBe(false);
    expect(exitCode).toBe(0);
  });
});

describe('freelo taskchecks finish — batch surfaces', () => {
  it('multi positional emits one envelope per id', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200, [B]: 200 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      String(B),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const envs = parseAllJsonLines(stdout) as unknown as TransitionEnvelope[];
    expect(envs.map((e) => e.data.taskcheck_id)).toEqual([A, B]);
  });

  it('--ids accepts a space-separated list', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200, [B]: 200 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      '--ids',
      `${A} ${B}`,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(parseAllJsonLines(stdout)).toHaveLength(2);
  });

  it('--stdin NDJSON tags each envelope with its line_index', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200, [B]: 200 }));
    const restore = pipeStdin(`{"id": ${A}}\n{"id": ${B}}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'finish',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const envs = parseAllJsonLines(stdout) as unknown as TransitionEnvelope[];
      expect(envs.map((e) => e.data.line_index)).toEqual([0, 1]);
    } finally {
      restore();
    }
  });

  it('empty stdin is a silent success', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));
    const restore = pipeStdin('');

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'finish',
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

  it('mixed batch: per-item error envelope, highest exit code wins', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200, [MISSING]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      String(MISSING),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    const failure = lines[1] as unknown as ErrorEnvelope;
    expect(failure.error.context).toMatchObject({ input_index: 1, taskcheck_id: MISSING });
    expectIdSpaceHint(failure.error, 'tasks finish');
  });

  it('a bad NDJSON line reports line_index and the batch continues', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200 }));
    const restore = pipeStdin(`{"id": "not a number"}\n{"id": ${A}}\n`);

    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'taskchecks',
        'finish',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0] as unknown as ErrorEnvelope).error.context).toMatchObject({ line_index: 0 });
    } finally {
      restore();
    }
  });

  it('batch failures render as human lines when --output human', async () => {
    server.use(taskchecksHandlers.finishMatrix({ [A]: 200, [MISSING]: 404 }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      String(MISSING),
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).toContain(`Finished taskcheck ${A}.`);
    expect(stdout).toContain(`Failed item 2 (${MISSING}):`);
  });
});

describe('freelo taskchecks finish/reopen — the 404 id-space contract (decision 4)', () => {
  it('finish: 404 is an error (exit 4), never "already finished"', async () => {
    server.use(taskchecksHandlers.finishNotFound(MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(MISSING),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).not.toContain('freelo.taskchecks.finish/v1');
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.http_status).toBe(404);
    expectIdSpaceHint(env.error, 'tasks finish');
  });

  it('reopen: 404 is an error (exit 4), never "already active"', async () => {
    server.use(taskchecksHandlers.activateNotFound(MISSING));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'reopen',
      String(MISSING),
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    expect(stdout).not.toContain('freelo.taskchecks.reopen/v1');
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.http_status).toBe(404);
    expectIdSpaceHint(env.error, 'tasks reopen');
  });
});

describe('freelo taskchecks finish — input validation (exit 2)', () => {
  it('no input source at all', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['taskchecks', 'finish', '--output', 'json']);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toContain('freelo subtasks list');
  });

  it('combining --stdin with positional ids is rejected', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      String(A),
      '--stdin',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.message).toMatch(/exactly one input source/);
  });

  it('a non-numeric positional id is rejected before any wire call', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'finish',
      'abc',
      '--output',
      'json',
    ]);

    expect(called).toBe(false);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.hint_next).toContain('subtasks list');
  });
});
