/**
 * End-to-end tests for `freelo tasks create` (R09, spec 0019).
 *
 * Covers the first write command and the shared write infrastructure
 * (`src/lib/dry-run.ts`, `src/lib/batch.ts`, NDJSON streamer).
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call, not just "an error envelope was emitted."
 * Calibration §2: each typed error class (`ValidationError`,
 * `FreeloApiError`, `NetworkError`, `RateLimitedError`) has a triggering test.
 * Calibration §4: each new try/catch arm in `runBatch` (parse-fail catch,
 * per-line POST catch, validate-batch-line catch) is covered.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import {
  server,
  tasksCreateHandlers,
  tasksEditHandlers,
  tasklistShowHandlers,
} from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasks', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

const tasklistDetail314 = {
  id: 314,
  name: 'Backend QA',
  project_id: 42,
  date_add: '2026-01-15T09:00:00Z',
  date_edited_at: '2026-04-20T11:23:45Z',
  tasks: [],
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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

/**
 * Replace process.stdin with an in-memory readable stream carrying `text`.
 * Returns a restore function. `process.stdin` typing is loose; we cast it.
 */
function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
  // The command reads via `for await (const … of iterateLines(process.stdin))`;
  // Readable.from yields strings, but iterateLines calls setEncoding which is
  // a no-op on object-mode-from-iterator streams — and iteration of strings
  // works as-is.
  Object.defineProperty(process, 'stdin', {
    configurable: true,
    value: stream,
  });
  return () => {
    Object.defineProperty(process, 'stdin', {
      configurable: true,
      value: original,
    });
  };
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
    `freelo-tasks-create-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

// ---------------------------------------------------------------------------
//  Happy paths — single mode
// ---------------------------------------------------------------------------

describe('freelo tasks create — single mode happy paths', () => {
  it('minimal flags: --tasklist + --name → JSON envelope, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit auth flow',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task: { id: number; name: string }; tasklist_id: number; project_id: number };
    };
    expect(env.schema).toBe('freelo.tasks.create/v2');
    expect(env.data.task.id).toBe(9012);
    expect(env.data.task.name).toBe('Audit auth flow');
    expect(env.data.tasklist_id).toBe(314);
    expect(env.data.project_id).toBe(42);
  });

  it('every flag: create body has NO labels; attach POST receives the labels (spec 0041)', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    let capturedCreateBody: unknown;
    let capturedAttachBody: unknown;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.okWhenBody(
        42,
        314,
        (body) => {
          capturedCreateBody = body;
          return true;
        },
        created,
      ),
      tasksEditHandlers.addLabelsOkWhenBody(9012, (body) => {
        capturedAttachBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Full body',
      '--worker',
      '17',
      '--due',
      '2026-05-01',
      '--priority',
      'high',
      '--label',
      'blocker',
      '--label',
      'qa',
      '--description',
      'Description text.',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(capturedCreateBody).toEqual({
      name: 'Full body',
      due_date: '2026-05-01T00:00:00Z',
      worker: 17,
      priority_enum: 'h',
      comment: { content: 'Description text.' },
    });
    // The labels travel out-of-band on a follow-up attach call (spec 0041 §5.1).
    expect(capturedAttachBody).toEqual({
      labels: [{ name: 'blocker' }, { name: 'qa' }],
    });
  });

  it('--description-file reads UTF-8 and sends content as comment', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    const filePath = join(testDir, 'desc.txt');
    await writeFile(filePath, 'File-sourced description.', 'utf8');

    let capturedBody: unknown;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.okWhenBody(
        42,
        314,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--description-file',
      filePath,
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect((capturedBody as { comment?: { content: string } }).comment).toEqual({
      content: 'File-sourced description.',
    });
  });

  it('--worker repeated: sends only first id, envelope carries notice', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    let capturedBody: unknown;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.okWhenBody(
        42,
        314,
        (body) => {
          capturedBody = body;
          return true;
        },
        created,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--worker',
      '17',
      '--worker',
      '23',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect((capturedBody as { worker: number }).worker).toBe(17);
    const env = parseFirstJson(stdout) as { notice?: string };
    expect(env.notice).toMatch(/Discarded: 23/);
  });

  it('human mode renders the success line', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit auth flow',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created task #9012');
    expect(stdout).toContain('tasklist 314');
    expect(stdout).toContain('project 42');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks create — dry-run', () => {
  it('--dry-run: lookup runs, no POST, envelope carries dry_run + would', async () => {
    let postCount = 0;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.okWhenBody(
        42,
        314,
        () => {
          postCount += 1;
          return true;
        },
        { id: 9999, name: 'should not happen' },
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Test',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(postCount).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: {
        tasklist_id: number;
        project_id: number;
        would: Array<{ method: string; path: string; body: { name: string } }>;
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.project_id).toBe(42);
    expect(Array.isArray(env.data.would)).toBe(true);
    expect(env.data.would).toHaveLength(1);
    expect(env.data.would[0]!.method).toBe('POST');
    expect(env.data.would[0]!.path).toBe('/project/42/tasklist/314/tasks');
    expect(env.data.would[0]!.body.name).toBe('Test');
  });

  it('--dry-run + --project: no HTTP at all', async () => {
    // No handlers registered — any HTTP call would hit unhandled-request error.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Test',
      '--dry-run',
      '--project',
      '99',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { project_id: number; would: Array<{ path: string }> };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.project_id).toBe(99);
    expect(env.data.would).toHaveLength(1);
    expect(env.data.would[0]!.path).toBe('/project/99/tasklist/314/tasks');
  });

  it('--dry-run + --label: would array carries TWO entries (create + attach placeholder)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--project',
      '42',
      '--name',
      'Test',
      '--label',
      'bug',
      '--label',
      'urgent',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        would: Array<{ method: string; path: string; body: unknown }>;
      };
    };
    expect(env.data.would).toHaveLength(2);
    expect(env.data.would[0]!.path).toBe('/project/42/tasklist/314/tasks');
    expect(env.data.would[1]!.path).toBe('/task-labels/add-to-task/{new_task_id}');
    expect(env.data.would[1]!.body).toEqual({
      labels: [{ name: 'bug' }, { name: 'urgent' }],
    });
  });
});

// ---------------------------------------------------------------------------
//  Validation failures (ValidationError, exit 2)
// ---------------------------------------------------------------------------

describe('freelo tasks create — validation', () => {
  it('missing --tasklist → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--tasklist not a positive integer → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
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

  it('missing --name in single mode → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--name is required/);
  });

  it('--name AND --stdin → exit 2', async () => {
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stderr, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--name',
        'X',
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
      const env = parseFirstJson(stderr) as { error: { code: string } };
      expect(env.error.code).toBe('VALIDATION_ERROR');
    } finally {
      restore();
    }
  });

  it('bad --due → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--due',
      'not-a-date',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --priority → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--priority',
      'urgent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--description AND --description-file → exit 2', async () => {
    const filePath = join(testDir, 'desc.txt');
    await writeFile(filePath, 'x', 'utf8');
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--description',
      'inline',
      '--description-file',
      filePath,
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--description-file path missing → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--description-file',
      join(testDir, 'does-not-exist.txt'),
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/Failed to read --description-file/);
  });

  it('--description-file AND --stdin → exit 2', async () => {
    const filePath = join(testDir, 'desc.txt');
    await writeFile(filePath, 'x', 'utf8');
    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--description-file',
        filePath,
        '--stdin',
        '--output',
        'json',
      ]);
      expect(exitCode).toBe(2);
    } finally {
      restore();
    }
  });

  it('empty --label → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--label',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project without --dry-run → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--project',
      '99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--project is only valid with --dry-run/);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths (FreeloApiError, RateLimitedError, NetworkError)
// ---------------------------------------------------------------------------

describe('freelo tasks create — HTTP errors', () => {
  it('tasklist lookup 404 → FREELO_API_ERROR exit 4, no POST attempted', async () => {
    server.use(tasklistShowHandlers.detailNotFound(314));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('POST 403 (worker not assignable) → FORBIDDEN exit 4', async () => {
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.forbidden(42, 314),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--worker',
      '9999',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.http_status).toBe(403);
  });

  it('POST 429 → RATE_LIMITED exit 6, retryable: true', async () => {
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.rateLimited(42, 314),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as {
      error: { code: string; retryable: boolean };
    };
    expect(env.error.code).toBe('RATE_LIMITED');
    expect(env.error.retryable).toBe(true);
  });

  it('POST network failure → NETWORK_ERROR exit 5', async () => {
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.networkError(42, 314),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });

  it('POST 5xx → FREELO_API_ERROR exit 4, retryable: true', async () => {
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.serverError(42, 314, 503),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
//  Label flow (spec 0041) — single mode
// ---------------------------------------------------------------------------

describe('freelo tasks create — labels (spec 0041)', () => {
  it('1 label, attach OK: applied_labels populated, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    let attachBody: unknown;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsOkWhenBody(9012, (body) => {
        attachBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--label',
      'bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(attachBody).toEqual({ labels: [{ name: 'bug' }] });
    const env = parseFirstJson(stdout) as {
      data: {
        applied_labels: { requested: string[]; attached: string[]; failed: unknown[] };
      };
    };
    expect(env.data.applied_labels.requested).toEqual(['bug']);
    expect(env.data.applied_labels.attached).toEqual(['bug']);
    expect(env.data.applied_labels.failed).toEqual([]);
  });

  it('2 labels: attach POST carries both names in a single batched body', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    // Using `okWhenBody` with `capturedBody` (overwritten on each call) — under
    // vitest+MSW v2 the predicate may be invoked twice per fetch (known quirk
    // documented in the existing 422 batch test). What matters for the contract
    // is that the body shape carries both names and the final response is 200.
    let capturedBody: unknown;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsOkWhenBody(9012, (body) => {
        capturedBody = body;
        return true;
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--label',
      'bug',
      '--label',
      'urgent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    // Single batched body — both names in ONE request, not two.
    expect(capturedBody).toEqual({
      labels: [{ name: 'bug' }, { name: 'urgent' }],
    });
    const env = parseFirstJson(stdout) as {
      data: {
        applied_labels: { attached: string[] };
      };
    };
    expect(env.data.applied_labels.attached).toEqual(['bug', 'urgent']);
  });

  it('attach 422: stdout success envelope (with applied_labels.failed) + stderr error envelope, exit 4', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsUnprocessable(9012, 'Color #aabbcc of label is not a valid value'),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--label',
      'bug',
      '--label',
      'urgent',
      '--output',
      'json',
    ]);
    // FreeloApiError (4xx other than 401) → exit 4.
    expect(exitCode).toBe(4);

    // stdout: success-shaped envelope, applied_labels.failed populated.
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task: { id: number };
        applied_labels: {
          requested: string[];
          attached: string[];
          failed: Array<{ name: string; error_code: string; http_status: number; message: string }>;
        };
      };
      notice?: string;
    };
    expect(env.schema).toBe('freelo.tasks.create/v2');
    expect(env.data.task.id).toBe(9012);
    expect(env.data.applied_labels.requested).toEqual(['bug', 'urgent']);
    expect(env.data.applied_labels.attached).toEqual([]);
    expect(env.data.applied_labels.failed).toHaveLength(2);
    expect(env.data.applied_labels.failed[0]!.name).toBe('bug');
    expect(env.data.applied_labels.failed[0]!.http_status).toBe(422);
    expect(env.data.applied_labels.failed[1]!.name).toBe('urgent');
    expect(env.notice).toMatch(/Task created but label attach failed/);

    // stderr: error envelope with task_id + requested_label_names context.
    const errEnv = parseFirstJson(stderr) as {
      schema: string;
      error: {
        code: string;
        http_status: number;
        context: { task_id: number; requested_label_names: string[] };
      };
    };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.http_status).toBe(422);
    expect(errEnv.error.context.task_id).toBe(9012);
    expect(errEnv.error.context.requested_label_names).toEqual(['bug', 'urgent']);
  });

  it('attach 502: failed[*] retryable=true on stderr envelope, exit 4', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsServerError(9012, 502),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--label',
      'bug',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stdout) as {
      data: {
        applied_labels: {
          attached: string[];
          failed: Array<{ name: string; error_code: string; http_status: number }>;
        };
      };
    };
    expect(env.data.applied_labels.attached).toEqual([]);
    expect(env.data.applied_labels.failed[0]!.error_code).toBe('SERVER_ERROR');
    expect(env.data.applied_labels.failed[0]!.http_status).toBe(502);
    const errEnv = parseFirstJson(stderr) as {
      error: { retryable: boolean; code: string };
    };
    expect(errEnv.error.code).toBe('SERVER_ERROR');
    expect(errEnv.error.retryable).toBe(true);
  });

  it('attach network error: failed[*] populated, exit 5', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsNetworkError(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--label',
      'bug',
      '--output',
      'json',
    ]);
    // NetworkError → exit 5.
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stdout) as {
      data: {
        task: { id: number };
        applied_labels: { failed: Array<{ name: string; error_code: string }> };
      };
    };
    // Task was created — agents must still see the id on stdout.
    expect(env.data.task.id).toBe(9012);
    expect(env.data.applied_labels.failed[0]!.error_code).toBe('NETWORK_ERROR');
    const errEnv = parseFirstJson(stderr) as { error: { code: string } };
    expect(errEnv.error.code).toBe('NETWORK_ERROR');
  });

  it('no --label: applied_labels is ABSENT (preserve absent-vs-empty distinction)', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { data: Record<string, unknown> };
    expect('applied_labels' in env.data).toBe(false);
  });

  it('human mode: success line includes "Attached labels: …"', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsOk(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'create',
      '--tasklist',
      '314',
      '--name',
      'Audit auth flow',
      '--label',
      'bug',
      '--label',
      'urgent',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Created task #9012');
    expect(stdout).toContain('Attached labels: bug, urgent');
  });
});

// ---------------------------------------------------------------------------
//  Batch (--stdin) mode
// ---------------------------------------------------------------------------

describe('freelo tasks create — batch (--stdin)', () => {
  it('three valid lines → three success envelopes, exit 0', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      // Line 3 carries `label: ['ops']` — attach handler required for the
      // post-create attach call (spec 0041 §5.1 / §7.3).
      tasksEditHandlers.addLabelsOk(9012),
    );

    const ndjson =
      `${JSON.stringify({ name: 'A' })}\n` +
      `${JSON.stringify({ name: 'B', priority: 'high' })}\n` +
      `${JSON.stringify({ name: 'C', label: ['ops'] })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect((lines[0]!['data'] as { line_index: number }).line_index).toBe(0);
      expect((lines[1]!['data'] as { line_index: number }).line_index).toBe(1);
      expect((lines[2]!['data'] as { line_index: number }).line_index).toBe(2);
      for (const line of lines) {
        expect(line['schema']).toBe('freelo.tasks.create/v2');
      }
    } finally {
      restore();
    }
  });

  it('valid + bad-JSON + valid → 2 success + 1 error, exit 2 (validation only)', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
    );

    const ndjson =
      `${JSON.stringify({ name: 'A' })}\n` +
      `{"name": broken\n` +
      `${JSON.stringify({ name: 'C' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(3);
      expect(lines[0]!['schema']).toBe('freelo.tasks.create/v2');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect((lines[1]!['error'] as { context: { line_index: number } }).context.line_index).toBe(
        1,
      );
      expect(lines[2]!['schema']).toBe('freelo.tasks.create/v2');
    } finally {
      restore();
    }
  });

  it('valid + 422-from-API → 1 success + 1 error, exit 4 (HTTP > validation)', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    const url = `https://api.freelo.io/v1/project/42/tasklist/314/tasks`;
    // Use http.post.once handlers to chain ordered responses. MSW consumes
    // each `.once()` handler after a single match, so we register a third
    // one as a safety-net to avoid `onUnhandledRequest: 'error'` if MSW's
    // internals invoke the handler more than once per fetch.
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      http.post(url, () => HttpResponse.json(created), { once: true }),
      http.post(
        url,
        () => HttpResponse.json({ errors: ['Server-side validation failed.'] }, { status: 422 }),
        { once: true },
      ),
      // Safety net: if a handler is invoked twice per fetch (MSW v2 quirk
      // observed under vitest with `vi.resetModules()`), the third+ matches
      // also return 422 so the resulting envelope shape stays consistent.
      http.post(url, () =>
        HttpResponse.json({ errors: ['Server-side validation failed.'] }, { status: 422 }),
      ),
    );

    const ndjson = `${JSON.stringify({ name: 'A' })}\n` + `${JSON.stringify({ name: 'B' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      const lines = parseAllJsonLines(stdout);
      expect(exitCode).toBe(4);
      expect(lines).toHaveLength(2);
      expect(lines[0]!['schema']).toBe('freelo.tasks.create/v2');
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect((lines[1]!['error'] as { http_status: number }).http_status).toBe(422);
    } finally {
      restore();
    }
  });

  it('line carrying `tasklist` → error envelope for that line', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
    );

    const ndjson = `${JSON.stringify({ name: 'A', tasklist: 999 })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect(lines[0]!['schema']).toBe('freelo.error/v1');
      expect((lines[0]!['error'] as { message: string }).message).toMatch(
        /per-line 'tasklist' is not allowed/,
      );
    } finally {
      restore();
    }
  });

  it('line carrying `description_file` → error envelope (decision 5)', async () => {
    server.use(tasklistShowHandlers.detailOk(314, tasklistDetail314));

    const ndjson = `${JSON.stringify({ name: 'A', description_file: '/etc/passwd' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(2);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(1);
      expect((lines[0]!['error'] as { message: string }).message).toMatch(
        /'description_file' is not allowed/,
      );
    } finally {
      restore();
    }
  });

  it('empty stdin → silent success, exit 0 (decision 9)', async () => {
    server.use(tasklistShowHandlers.detailOk(314, tasklistDetail314));

    const restore = pipeStdin('');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      expect(stdout).toBe('');
    } finally {
      restore();
    }
  });

  it('--dry-run + --stdin: lookup runs, no POSTs, per-line dry envelopes', async () => {
    let postCount = 0;
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.okWhenBody(
        42,
        314,
        () => {
          postCount += 1;
          return true;
        },
        { id: 9999, name: 'should not happen' },
      ),
    );

    const ndjson = `${JSON.stringify({ name: 'A' })}\n` + `${JSON.stringify({ name: 'B' })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--dry-run',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(0);
      expect(postCount).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      for (const line of lines) {
        expect(line['dry_run']).toBe(true);
        expect((line['data'] as { project_id: number }).project_id).toBe(42);
      }
    } finally {
      restore();
    }
  });

  it('per-line attach failure (502): success + error envelopes per line, exit 4 (spec 0041 §7.3)', async () => {
    const created = await loadFixture<Record<string, unknown>>('create-9012.json');
    server.use(
      tasklistShowHandlers.detailOk(314, tasklistDetail314),
      tasksCreateHandlers.ok(42, 314, created),
      tasksEditHandlers.addLabelsServerError(9012, 502),
    );

    const ndjson =
      `${JSON.stringify({ name: 'A', label: ['bug'] })}\n` +
      `${JSON.stringify({ name: 'B', label: ['urgent'] })}\n`;
    const restore = pipeStdin(ndjson);
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'tasks',
        'create',
        '--tasklist',
        '314',
        '--stdin',
        '--output',
        'ndjson',
      ]);
      expect(exitCode).toBe(4);
      const lines = parseAllJsonLines(stdout);
      // Two input lines × (1 success envelope + 1 error envelope) = 4 NDJSON lines.
      expect(lines).toHaveLength(4);
      expect(lines[0]!['schema']).toBe('freelo.tasks.create/v2');
      expect(
        (lines[0]!['data'] as { applied_labels: { failed: unknown[] } }).applied_labels.failed,
      ).toHaveLength(1);
      expect(lines[1]!['schema']).toBe('freelo.error/v1');
      expect(
        (lines[1]!['error'] as { context: { task_id: number; line_index: number } }).context
          .task_id,
      ).toBe(9012);
      expect(lines[2]!['schema']).toBe('freelo.tasks.create/v2');
      expect(lines[3]!['schema']).toBe('freelo.error/v1');
    } finally {
      restore();
    }
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo tasks create — introspect', () => {
  it('shows up in --introspect with the right schema and destructive flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{
          name: string;
          output_schema: string;
          destructive: boolean;
        }>;
      };
    };
    const create = env.data.commands.find((c) => c.name === 'tasks create');
    expect(create).toBeDefined();
    expect(create!.output_schema).toBe('freelo.tasks.create/v2');
    expect(create!.destructive).toBe(false);
  });
});
