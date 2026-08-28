/**
 * End-to-end tests for `freelo task-labels find` (M04, spec 0062).
 *
 * Covers:
 *   - Happy paths: multiple labels, --output human (table renderer).
 *   - **Empty result is a success (exit 0)** on both documented arms:
 *     inaccessible `--project`, and caller with no accessible projects.
 *     Spec 0062 §5 — this is the crux of the slice.
 *   - Query composition: `--project 42` → `?project_id=42`; omitted → no
 *     query string at all. Both assert the outbound path is
 *     `/task-labels/find-available`, which fails loudly if the sibling
 *     `/project-labels/find-available` were wired by mistake (spec §3.1).
 *   - Flag validation: non-numeric / zero `--project` → ValidationError exit 2,
 *     request never sent.
 *   - Schema validation: malformed wire body → VALIDATION_ERROR exit 4.
 *   - HTTP errors: 401 (exit 3), 5xx (exit 4), 429 (exit 6), network (exit 5).
 *   - Introspect entry shows output_schema and destructive: false.
 *
 * Calibration §1-2: every typed-error path the spec assigns an exit code has
 * at least one assertion.
 *
 * No TTY-prompt path in this command (read-only, no confirmation gate), so
 * calibration §7's `CI`-clearing requirement does not apply — the human-output
 * tests drive the renderer through `--output human`, not TTY detection.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, taskLabelsHandlers } from '../../msw/handlers.js';

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
    /* swallow */
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

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterAll(() => {
  server.close();
});

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-task-labels-find-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

/* ---------------------------------------------------------------------------
 *  Fixtures — `TaskLabel` is uuid-keyed and has no `id` (yaml :5949-5958).
 * ------------------------------------------------------------------------- */

const BUG = {
  uuid: '0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d',
  name: 'Bug',
  color: '#e9483a',
};

const CHORE = {
  uuid: '3a1c9d8e-7f6a-5b4c-3d2e-1f0a9b8c7d6e',
  name: 'Chore',
  color: '#77787a',
};

describe('freelo task-labels find — happy paths', () => {
  it('multiple labels: emits envelope with labels[], count, exit 0', async () => {
    server.use(taskLabelsHandlers.findOk([BUG, CHORE]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { labels: Array<{ uuid?: string; name?: string }>; count: number; project_id?: number };
    };
    expect(env.schema).toBe('freelo.task_labels.find/v1');
    expect(env.data.labels).toHaveLength(2);
    expect(env.data.count).toBe(2);
    expect(env.data.labels[0]!.uuid).toBe(BUG.uuid);
    expect(env.data.labels[1]!.name).toBe('Chore');
    // No --project passed → the discriminator field is absent.
    expect(env.data.project_id).toBeUndefined();
  });

  it('--project echoes project_id into the envelope', async () => {
    server.use(taskLabelsHandlers.findOk([BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      '42',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: { project_id?: number; count: number } };
    expect(env.data.project_id).toBe(42);
    expect(env.data.count).toBe(1);
  });

  it('human output: renders a table with the uuid, name and color', async () => {
    server.use(taskLabelsHandlers.findOk([BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Bug');
    expect(stdout).toContain('#e9483a');
    expect(stdout).toContain(BUG.uuid);
  });

  it('human output: tolerates labels with null/undefined fields', async () => {
    server.use(taskLabelsHandlers.findOk([{ uuid: null, name: null, color: null }]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('-');
  });
});

/* ---------------------------------------------------------------------------
 *  The crux: empty is a legitimate success, not a failure path.
 * ------------------------------------------------------------------------- */

describe('freelo task-labels find — empty results are successes (spec 0062 §5)', () => {
  it('caller has no accessible projects → exit 0, labels: [], count: 0', async () => {
    server.use(taskLabelsHandlers.findOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { labels: unknown[]; count: number };
    };
    expect(env.schema).toBe('freelo.task_labels.find/v1');
    expect(env.data.labels).toEqual([]);
    expect(env.data.count).toBe(0);
  });

  it('--project names an inaccessible project → exit 0, labels: [], project_id echoed', async () => {
    // The API cannot distinguish "no such project" / "you can't see it" /
    // "it has no labels" — all three are 200 {"labels":[]}. Exit 0, no 404.
    server.use(taskLabelsHandlers.findOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      '999999',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { labels: unknown[]; count: number; project_id?: number };
    };
    expect(env.data.labels).toEqual([]);
    expect(env.data.count).toBe(0);
    expect(env.data.project_id).toBe(999999);
  });

  it('human output: empty list shows the (no task labels) placeholder row', async () => {
    server.use(taskLabelsHandlers.findOk([]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no task labels)');
  });
});

/* ---------------------------------------------------------------------------
 *  Query composition — also guards against wiring the project-labels sibling.
 * ------------------------------------------------------------------------- */

/*
 * These assert the *content* of every captured request, not the request
 * count. The MSW/undici test harness invokes a GET resolver more than once
 * per logical CLI invocation — reproduced identically on the pre-existing
 * `freelo labels list` path, so it is a harness artifact, not a property of
 * this command (spec 0062 decision 06). Asserting `toHaveLength(1)` would be
 * testing the harness. Asserting that *every* outbound request carries the
 * right path and query still fully guards the wiring, including against the
 * `/project-labels/find-available` sibling being hooked up by mistake.
 */
describe('freelo task-labels find — request composition', () => {
  it('--project 42 sends ?project_id=42 to /task-labels/find-available', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.findOkCapturing(seen, [BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      '42',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const raw of seen) {
      const url = new URL(raw);
      expect(url.pathname).toBe('/v1/task-labels/find-available');
      expect(url.searchParams.get('project_id')).toBe('42');
    }
  });

  it('no --project sends no query string at all', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.findOkCapturing(seen, [BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(0);
    expect(seen.length).toBeGreaterThan(0);
    for (const raw of seen) {
      const url = new URL(raw);
      expect(url.pathname).toBe('/v1/task-labels/find-available');
      expect(url.search).toBe('');
    }
  });
});

describe('freelo task-labels find — flag validation', () => {
  it('--project abc → ValidationError exit 2, no request sent', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.findOkCapturing(seen, [BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(stdout + stderr).toContain('VALIDATION_ERROR');
    expect(seen).toHaveLength(0);
  });

  it('--project 0 → ValidationError exit 2', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.findOkCapturing(seen, [BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(seen).toHaveLength(0);
  });

  it('--project -5 → ValidationError exit 2', async () => {
    const seen: string[] = [];
    server.use(taskLabelsHandlers.findOkCapturing(seen, [BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--project',
      '-5',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe('freelo task-labels find — error paths', () => {
  it('401 → exit 3 (FreeloApiError)', async () => {
    server.use(taskLabelsHandlers.findUnauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('5xx → exit 4 (FreeloApiError)', async () => {
    server.use(taskLabelsHandlers.findServerError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6 (RateLimitedError)', async () => {
    server.use(taskLabelsHandlers.findRateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(6);
  });

  it('network error → exit 5 (NetworkError)', async () => {
    server.use(taskLabelsHandlers.findNetworkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['task-labels', 'find', '--output', 'json']);
    expect(exitCode).toBe(5);
  });

  it('malformed body (labels key missing) → VALIDATION_ERROR exit 4', async () => {
    server.use(taskLabelsHandlers.findMalformed());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'task-labels',
      'find',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout + stderr).toContain('VALIDATION_ERROR');
  });
});

describe('freelo task-labels find — request-id propagation', () => {
  it('--request-id is forwarded into the response envelope', async () => {
    const reqId = '550e8400-e29b-41d4-a716-446655440000';
    server.use(taskLabelsHandlers.findOk([BUG]));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      '--request-id',
      reqId,
      'task-labels',
      'find',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { request_id?: string };
    expect(env.request_id).toBe(reqId);
  });
});

describe('freelo task-labels find — introspect', () => {
  it('lists task-labels find with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; output_schema?: string; destructive?: boolean }> };
    };
    const entry = env.data.commands.find((c) => c.name === 'task-labels find');
    expect(entry).toBeDefined();
    expect(entry?.output_schema).toBe('freelo.task_labels.find/v1');
    expect(entry?.destructive).toBe(false);
  });
});
