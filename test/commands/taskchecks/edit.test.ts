/**
 * End-to-end tests for `freelo taskchecks edit <id>` (M03, spec 0066).
 *
 * Covers the happy path, the narrow edit surface, `--dry-run`, every
 * validation branch in spec 0066 §7, and the load-bearing 404 contract
 * (spec 0066 §5.1 / decision 4): a 404 is an ERROR with an id-space hint,
 * never an idempotent success.
 *
 * Calibration §2: every error path the spec assigns an exit code asserts that
 * exit code, and each typed error class has a triggering test.
 * M07 decision 6: assert request *content*, never request *counts*.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { server, taskchecksHandlers } from '../../msw/handlers.js';
import {
  expectIdSpaceHint,
  parseFirstJson,
  runCli,
  setUpEach,
  tearDownEach,
  warmUpCli,
  type ErrorEnvelope,
  type TransitionEnvelope,
} from './harness.js';

const ID = 4821;

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  await warmUpCli();
}, 60_000);
afterAll(() => {
  server.close();
});
beforeEach(async () => {
  await setUpEach('taskchecks-edit');
});
afterEach(async () => {
  server.resetHandlers();
  await tearDownEach();
});

describe('freelo taskchecks edit — happy paths', () => {
  it('--name sends only { name } and emits freelo.taskchecks.edit/v1', async () => {
    let body: unknown;
    server.use(taskchecksHandlers.editOk(ID, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'Rewrite intro',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(body).toEqual({ name: 'Rewrite intro' });
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.schema).toBe('freelo.taskchecks.edit/v1');
    expect(env.data.taskcheck_id).toBe(ID);
    expect(env.data.applied_changes).toEqual(['name']);
    expect(env.data.notify_author).toBe(false);
    expect(env).toHaveProperty('rate_limit');
  });

  it('--worker sends the numeric id; applied_changes reports "worker"', async () => {
    let body: unknown;
    server.use(taskchecksHandlers.editOk(ID, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--worker',
      '7',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(body).toEqual({ worker: 7 });
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data.applied_changes).toEqual(['worker']);
  });

  it('--clear-worker sends worker: null; applied_changes reports "clear_worker"', async () => {
    let body: unknown;
    server.use(taskchecksHandlers.editOk(ID, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--clear-worker',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(body).toEqual({ worker: null });
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data.applied_changes).toEqual(['clear_worker']);
  });

  it('--notify-author IS accepted here — this endpoint declares a requestBody (decision 3)', async () => {
    let body: unknown;
    server.use(taskchecksHandlers.editOk(ID, (b) => (body = b)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--notify-author',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(body).toEqual({ name: 'x', notify_author: true });
    const env = parseFirstJson(stdout) as TransitionEnvelope;
    expect(env.data.notify_author).toBe(true);
  });

  it('human output renders the applied-changes line', async () => {
    server.use(taskchecksHandlers.editOk(ID, () => {}));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--worker',
      '7',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain(`Edited taskcheck ${ID} (name, worker).`);
  });
});

describe('freelo taskchecks edit — dry run', () => {
  it('makes no wire call and echoes the exact body that would be sent', async () => {
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--clear-worker',
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
      path: `/taskcheck/${ID}`,
      body: { name: 'x', worker: null },
    });
  });

  it('dry-run works without credentials — no auth resolution on that path', async () => {
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    let called = false;
    server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(called).toBe(false);
    expect(exitCode).toBe(0);
  });
});

describe('freelo taskchecks edit — validation (ValidationError, exit 2)', () => {
  const cases: Array<{ label: string; argv: string[]; match: RegExp }> = [
    {
      label: 'non-numeric id',
      argv: ['taskchecks', 'edit', 'abc', '--name', 'x'],
      match: /<id> must be a positive integer/,
    },
    {
      label: 'zero id',
      argv: ['taskchecks', 'edit', '0', '--name', 'x'],
      match: /<id> must be a positive integer/,
    },
    {
      // NOTE: a *negative* id can't be tested positionally — Commander parses a
      // leading `-` as an option and exits 1 before our parser runs. That is
      // pre-existing framework behavior shared by every numeric-positional
      // command in this CLI. The negative case is covered via `--ids` in
      // delete.test.ts, where the value is a flag argument.
      label: 'fractional id',
      argv: ['taskchecks', 'edit', '1.5', '--name', 'x'],
      match: /<id> must be a positive integer/,
    },
    {
      label: 'non-numeric --worker',
      argv: ['taskchecks', 'edit', String(ID), '--worker', 'bob'],
      match: /--worker must be a positive integer/,
    },
    {
      label: 'empty --name',
      argv: ['taskchecks', 'edit', String(ID), '--name', '   '],
      match: /--name must not be empty/,
    },
    {
      label: '--worker with --clear-worker',
      argv: ['taskchecks', 'edit', String(ID), '--worker', '7', '--clear-worker'],
      match: /mutually exclusive/,
    },
    {
      label: 'no mutating flag at all',
      argv: ['taskchecks', 'edit', String(ID)],
      match: /Nothing to change/,
    },
    {
      label: '--notify-author alone is not a mutating change',
      argv: ['taskchecks', 'edit', String(ID), '--notify-author'],
      match: /Nothing to change/,
    },
  ];

  for (const c of cases) {
    it(`${c.label} → exit 2 VALIDATION_ERROR`, async () => {
      let called = false;
      server.use(...taskchecksHandlers.forbidAnyCall(() => (called = true)));

      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [...c.argv, '--output', 'json']);

      expect(called).toBe(false);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
      expect(env.error.code).toBe('VALIDATION_ERROR');
      expect(env.error.message).toMatch(c.match);
    });
  }

  it('a bad --worker hint points at USER ids, not at taskcheck ids', async () => {
    // `--worker` and `<id>` share a positive-integer rule but live in different
    // id spaces. Sending someone to `freelo subtasks list` for a bad worker id
    // would point them at the wrong lookup entirely.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--worker',
      'bob',
      '--output',
      'json',
    ]);

    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.hint_next).toContain('user id');
    expect(env.error.hint_next).not.toContain('subtasks list');
  });

  it('the "nothing to change" hint names only the three editable fields', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr } = await runCli(run, ['taskchecks', 'edit', String(ID), '--output', 'json']);

    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.hint_next).toContain('--name');
    expect(env.error.hint_next).toContain('--worker');
    expect(env.error.hint_next).toContain('--clear-worker');
    // R10's flag set is deliberately NOT reused — those fields are 400 here.
    expect(env.error.hint_next).not.toContain('--priority');
    expect(env.error.hint_next).not.toContain('--due');
  });
});

describe('freelo taskchecks edit — the 404 id-space contract (decision 4)', () => {
  it('404 is an ERROR (exit 4), never an idempotent success', async () => {
    server.use(taskchecksHandlers.editNotFound(ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    // Nothing that looks like a success envelope reached stdout.
    expect(stdout).not.toContain('freelo.taskchecks.edit/v1');
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.http_status).toBe(404);
    expect(env.error.retryable).toBe(false);
    expectIdSpaceHint(env.error, 'tasks edit');
  });
});

describe('freelo taskchecks edit — transport errors pass through untouched', () => {
  it.each([
    ['401 → AUTH_EXPIRED', 401, 3],
    ['403 → FORBIDDEN', 403, 4],
    ['500 → FREELO_API_ERROR', 500, 4],
  ])('%s maps to the established exit code', async (_label, status, expectedExit) => {
    server.use(taskchecksHandlers.editStatus(ID, status));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(expectedExit);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.http_status).toBe(status);
    // Only the 404 is rewritten — everything else keeps its generic message.
    expect(env.error.hint_next ?? '').not.toContain('freelo subtasks list');
  });

  it('429 surfaces as RateLimitedError', async () => {
    server.use(taskchecksHandlers.editStatus(ID, 429, { 'Retry-After': '0' }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--output',
      'json',
    ]);

    expect(exitCode).toBeGreaterThan(0);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('RATE_LIMITED');
  });

  it('a connection error surfaces as NetworkError', async () => {
    server.use(taskchecksHandlers.editNetworkError(ID));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'taskchecks',
      'edit',
      String(ID),
      '--name',
      'x',
      '--output',
      'json',
    ]);

    expect(exitCode).toBeGreaterThan(0);
    const env = parseFirstJson(stderr) as unknown as ErrorEnvelope;
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});
