/**
 * End-to-end tests for `freelo tasks edit <id>` (R10, spec 0020).
 *
 * Covers the second write command: partial-update edit body + label-diff
 * fan-out + post-edit refresh GET.
 *
 * Calibration §1: every typed error path asserts the **exit code** through a
 * captured `process.exit` call.
 * Calibration §2: each typed error class (`ValidationError`,
 * `FreeloApiError`, `NetworkError`, `RateLimitedError`) has a triggering test.
 * Calibration §4: each new try/catch arm — the lookup catch (early-abort),
 * the per-call fan-out catches (remove → add → edit), and the refresh-GET
 * success-with-notice arm — has a dedicated test row.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, tasksEditHandlers, tasksShowHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasks', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

const taskDetail9012 = {
  id: 9012,
  name: 'Audit auth flow',
  date_add: '2026-04-27T20:30:00Z',
  date_edited_at: '2026-04-27T20:30:00Z',
  due_date: '2026-04-30T00:00:00Z',
  due_date_end: null,
  date_finished: null,
  minutes: 0,
  priority_enum: 'm',
  count_subtasks: 0,
  parent_task_id: null,
  cost: null,
  author: { id: 9, fullname: 'Owner Name' },
  worker: { id: 17, fullname: 'Jane Doe' },
  state: { id: 1, state: 'active' },
  comments: [],
  labels: [],
  project: { id: 42, name: 'Site redesign' },
  tasklist: { id: 314, name: 'Backend QA' },
  custom_fields: [],
  total_time_estimate: null,
  users_time_estimates: [],
  tracking_users: [],
  multi_project_task: null,
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
    `freelo-tasks-edit-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths
// ---------------------------------------------------------------------------

describe('freelo tasks edit — happy paths', () => {
  it('minimal: only --name → JSON envelope, exit 0', async () => {
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      // 1. lookup GET
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      // 2. POST /task/9012 (returns TaskDetail; we ignore for envelope)
      tasksEditHandlers.ok(9012, edited),
      // 3. refresh GET — second handler for the same URL; MSW resolves the
      // most-recently-registered handler. To reuse the same URL twice we
      // register a fresh handler via http.get with `once: true` semantics
      // baked into MSW's resolution order is not guaranteed — use
      // `tasksShowHandlers.detailOk` which is idempotent and returns the
      // same body each time.
    );
    // Re-register the GET so both lookup AND refresh hit it. MSW v2 resolves
    // the most-recent handler first; registering once is enough since the
    // detail handler is stateless.

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'Audit auth flow (v2)',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        task: { id: number; name: string };
        tasklist_id: number;
        project_id: number;
        applied_changes: {
          edit: Record<string, unknown>;
          labels_added: string[];
          labels_removed: string[];
        };
      };
    };
    expect(env.schema).toBe('freelo.tasks.edit/v1');
    expect(env.data.task.id).toBe(9012);
    expect(env.data.tasklist_id).toBe(314);
    expect(env.data.project_id).toBe(42);
    expect(env.data.applied_changes.edit).toEqual({ name: 'Audit auth flow (v2)' });
    expect(env.data.applied_changes.labels_added).toEqual([]);
    expect(env.data.applied_changes.labels_removed).toEqual([]);
  });

  it('every editable field: body sent on the wire matches the builder', async () => {
    let editedBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.okWhenBody(
        9012,
        (body) => {
          editedBody = body;
          return true;
        },
        edited,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'New name',
      '--worker',
      '17',
      '--due',
      '2026-05-01',
      '--priority',
      'high',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(editedBody).toEqual({
      name: 'New name',
      worker: 17,
      due_date: '2026-05-01T00:00:00Z',
      priority_enum: 'h',
    });
  });

  it('--clear-priority sends priority_enum: null', async () => {
    let editedBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.okWhenBody(
        9012,
        (body) => {
          editedBody = body;
          return true;
        },
        edited,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--clear-priority',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(editedBody).toEqual({ priority_enum: null });
  });

  it('--add-label posts {labels:[{name}]} to add-to-task endpoint', async () => {
    let addBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.addLabelsOkWhenBody(9012, (body) => {
        addBody = body;
        return true;
      }),
      tasksEditHandlers.ok(9012, edited),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--add-label',
      'urgent',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(addBody).toEqual({ labels: [{ name: 'urgent' }] });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: { labels_added: string[]; edit: Record<string, unknown> } };
    };
    expect(env.data.applied_changes.labels_added).toEqual(['urgent']);
    expect(env.data.applied_changes.edit).toEqual({});
  });

  it('--remove-label posts {labels:[{name}]} to remove-from-task endpoint', async () => {
    let removeBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.removeLabelsOkWhenBody(9012, (body) => {
        removeBody = body;
        return true;
      }),
      tasksEditHandlers.ok(9012, edited),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--remove-label',
      'wontfix',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(removeBody).toEqual({ labels: [{ name: 'wontfix' }] });
    const env = parseFirstJson(stdout) as {
      data: { applied_changes: { labels_removed: string[] } };
    };
    expect(env.data.applied_changes.labels_removed).toEqual(['wontfix']);
  });

  it('full mix: wire order is remove → add → edit → refresh', async () => {
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    const callOrder: string[] = [];
    server.use(
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        callOrder.push('GET /task/9012');
        return HttpResponse.json(taskDetail9012);
      }),
      http.post(`https://api.freelo.io/v1/task-labels/remove-from-task/9012`, () => {
        callOrder.push('POST /task-labels/remove-from-task/9012');
        return HttpResponse.json({ result: 'success' });
      }),
      http.post(`https://api.freelo.io/v1/task-labels/add-to-task/9012`, () => {
        callOrder.push('POST /task-labels/add-to-task/9012');
        return HttpResponse.json({ result: 'success' });
      }),
      http.post(`https://api.freelo.io/v1/task/9012`, () => {
        callOrder.push('POST /task/9012');
        return HttpResponse.json(edited);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--add-label',
      'urgent',
      '--remove-label',
      'wontfix',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    // MSW v2 occasionally invokes a single handler twice per fetch when the
    // tests are run under vitest with `vi.resetModules()` (the same quirk
    // documented in `create.test.ts` for the batch-422 test). Collapse
    // identical adjacent entries before comparing — the **transition order**
    // is what matters, not whether each handler ran once or twice.
    const dedupedAdjacent = callOrder.filter(
      (entry, idx) => idx === 0 || entry !== callOrder[idx - 1],
    );
    // Lookup, then remove, then add, then edit, then refresh GET.
    expect(dedupedAdjacent).toEqual([
      'GET /task/9012',
      'POST /task-labels/remove-from-task/9012',
      'POST /task-labels/add-to-task/9012',
      'POST /task/9012',
      'GET /task/9012',
    ]);
  });

  it('--worker repeated → first-only on wire + notice in envelope', async () => {
    let editedBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.okWhenBody(
        9012,
        (body) => {
          editedBody = body;
          return true;
        },
        edited,
      ),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--worker',
      '17',
      '--worker',
      '23',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect((editedBody as { worker: number }).worker).toBe(17);
    const env = parseFirstJson(stdout) as { notice?: string };
    expect(env.notice).toMatch(/Discarded: 23/);
  });

  it('repeated --add-label dedupes (single label sent)', async () => {
    let addBody: unknown;
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.addLabelsOkWhenBody(9012, (body) => {
        addBody = body;
        return true;
      }),
      tasksEditHandlers.ok(9012, edited),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--add-label',
      'urgent',
      '--add-label',
      'urgent',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(addBody).toEqual({ labels: [{ name: 'urgent' }] });
  });

  it('label-only edit does NOT call POST /task/<id> (decision 15)', async () => {
    let editPosted = 0;
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.addLabelsOk(9012),
      http.post(`https://api.freelo.io/v1/task/9012`, () => {
        editPosted += 1;
        return HttpResponse.json(taskDetail9012);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--add-label',
      'urgent',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(editPosted).toBe(0);
  });

  it('human mode renders the success line', async () => {
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.ok(9012, edited),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'human',
    ]);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Edited task #9012');
    expect(stdout).toContain('name');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks edit — dry-run', () => {
  it('--dry-run: lookup runs, no POST, would[] populated', async () => {
    let postCount = 0;
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      http.post(`https://api.freelo.io/v1/task/9012`, () => {
        postCount += 1;
        return HttpResponse.json(taskDetail9012);
      }),
      http.post(`https://api.freelo.io/v1/task-labels/add-to-task/9012`, () => {
        postCount += 1;
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--add-label',
      'urgent',
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
        applied_changes: { edit: Record<string, unknown>; labels_added: string[] };
        would: { method: string; path: string; body: unknown }[];
      };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.tasklist_id).toBe(314);
    expect(env.data.project_id).toBe(42);
    expect(env.data.applied_changes.edit).toEqual({ name: 'X' });
    expect(env.data.applied_changes.labels_added).toEqual(['urgent']);
    expect(env.data.would).toHaveLength(2);
    // Order: add-labels (no remove this run), then edit-body.
    expect(env.data.would[0]!.path).toBe('/task-labels/add-to-task/9012');
    expect(env.data.would[1]!.path).toBe('/task/9012');
  });

  it('--dry-run + --project: zero HTTP at all', async () => {
    // No handlers registered — any HTTP call would hit unhandled-request error.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--priority',
      'low',
      '--dry-run',
      '--project',
      '99',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { tasklist_id: number | null; project_id: number; would: unknown[] };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.project_id).toBe(99);
    expect(env.data.tasklist_id).toBeNull();
    expect(env.data.would).toHaveLength(1);
  });

  it('human-mode dry-run renders (dry-run) prefix', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--priority',
      'low',
      '--dry-run',
      '--project',
      '99',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(dry-run)');
    expect(stdout).toContain('Would edit task #9012');
  });
});

// ---------------------------------------------------------------------------
//  Validation failures (ValidationError, exit 2) — calibration §2
// ---------------------------------------------------------------------------

describe('freelo tasks edit — validation', () => {
  it('<id> not a positive integer → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      'abc',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('no mutating flags → VALIDATION_ERROR exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasks', 'edit', '9012', '--output', 'json']);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/At least one of/);
  });

  it('--worker 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--worker',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('bad --due → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
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
      'edit',
      '9012',
      '--priority',
      'urgent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--priority AND --clear-priority → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--priority',
      'high',
      '--clear-priority',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { message: string } };
    expect(env.error.message).toMatch(/--priority or --clear-priority/);
  });

  it('--name "" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--add-label "" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--add-label',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--remove-label "" → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--remove-label',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('same name in --add-label and --remove-label → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--add-label',
      'urgent',
      '--remove-label',
      'urgent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { message: string } };
    expect(env.error.message).toMatch(/in both --add-label and --remove-label/);
  });

  it('--project without --dry-run → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--project',
      '99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { message: string } };
    expect(env.error.message).toMatch(/--project is only valid with --dry-run/);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths (FreeloApiError, RateLimitedError, NetworkError)
// ---------------------------------------------------------------------------

describe('freelo tasks edit — HTTP errors', () => {
  it('lookup GET 404 → NOT_FOUND exit 4, no further calls', async () => {
    let furtherCalls = 0;
    server.use(
      tasksShowHandlers.detailNotFound(9012),
      http.post(`https://api.freelo.io/v1/task/9012`, () => {
        furtherCalls += 1;
        return HttpResponse.json({ ok: 1 });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(furtherCalls).toBe(0);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('edit POST 403 → FORBIDDEN exit 4', async () => {
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.editForbidden(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--worker',
      '9999',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; http_status: number } };
    expect(env.error.code).toBe('FORBIDDEN');
    expect(env.error.http_status).toBe(403);
  });

  it('edit POST 422 → FREELO_API_ERROR exit 4', async () => {
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.editUnprocessable(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('add-labels 422 after successful remove → exit 4 (label-only edit, fan-out)', async () => {
    let removeCalled = false;
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      http.post(`https://api.freelo.io/v1/task-labels/remove-from-task/9012`, () => {
        removeCalled = true;
        return HttpResponse.json({ result: 'success' });
      }),
      tasksEditHandlers.addLabelsUnprocessable(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--remove-label',
      'wontfix',
      '--add-label',
      'urgent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(removeCalled).toBe(true);
    const env = parseFirstJson(stderr) as { error: { http_status: number } };
    expect(env.error.http_status).toBe(422);
  });

  it('edit POST 429 → RATE_LIMITED exit 6, retryable: true', async () => {
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.editRateLimited(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
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

  it('edit POST schema parse failure → FREELO_API_ERROR exit 4', async () => {
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.editMalformed(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('edit POST network failure → NETWORK_ERROR exit 5', async () => {
    server.use(
      tasksShowHandlers.detailOk(9012, taskDetail9012),
      tasksEditHandlers.editNetworkError(9012),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Post-edit refresh failure (calibration §4 — refresh catch arm)
// ---------------------------------------------------------------------------

describe('freelo tasks edit — refresh-GET failure (decision 11)', () => {
  it('all writes succeed but refresh GET 500s → success envelope, task: null, notice', async () => {
    const edited = await loadFixture<Record<string, unknown>>('edit-9012-detail.json');
    let getCount = 0;
    server.use(
      // First GET = lookup (200). Second GET = refresh (500).
      http.get(`https://api.freelo.io/v1/task/9012`, () => {
        getCount += 1;
        if (getCount === 1) return HttpResponse.json(taskDetail9012);
        return HttpResponse.json({ errors: ['boom'] }, { status: 500 });
      }),
      tasksEditHandlers.ok(9012, edited),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9012',
      '--name',
      'X',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { task: unknown; applied_changes: { edit: Record<string, unknown> } };
      notice?: string;
    };
    expect(env.data.task).toBeNull();
    expect(env.data.applied_changes.edit).toEqual({ name: 'X' });
    expect(env.notice).toBeDefined();
    expect(env.notice).toMatch(/post-edit refresh GET failed/);
  });
});

// ---------------------------------------------------------------------------
//  Regression — issue #105 / spec 0059: comments[].files[] without `id`
//
//  The live repro failed on the *lookup* GET (edit.ts:331), before any write:
//
//    Unexpected response shape from GET /task/18579501:
//    [{ code: "invalid_type", expected: "number", received: "undefined",
//       path: ["comments", 0, "files", 0, "id"], message: "Required" }]
//
//  Fixture is synthetic (spec 0059 §9) — the real captured body carried live
//  client data. Only the JSON types and the load-bearing key set survive.
// ---------------------------------------------------------------------------

describe('freelo tasks edit — comments[].files[] without `id` (issue #105)', () => {
  it('lookup GET returning a file with no `id` no longer aborts the edit — exit 0', async () => {
    const detail = await loadFixture<Record<string, unknown>>(
      'show-task-9020-comment-file-no-id.json',
    );
    let postCalled = false;
    server.use(
      tasksShowHandlers.detailOk(9020, detail),
      http.post(`https://api.freelo.io/v1/task/9020`, () => {
        postCalled = true;
        return HttpResponse.json(detail);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9020',
      '--name',
      'Renamed',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    // The write actually fired — before the fix we aborted on the lookup.
    expect(postCalled).toBe(true);
    const env = parseFirstJson(stdout) as {
      data: {
        task: { comments: Array<{ files: Array<Record<string, unknown>> }> } | null;
        applied_changes: { edit: Record<string, unknown> };
      };
    };
    expect(env.data.applied_changes.edit).toEqual({ name: 'Renamed' });

    // The file round-trips: `uuid` survives, `id` is simply absent (not
    // invented, not nulled into the payload).
    const files = env.data.task!.comments[0]!.files;
    expect(files[0]).toMatchObject({ uuid: 'file-uuid-aaaa-0001' });
    expect('id' in files[0]!).toBe(false);
    // Sibling entry proves a present `id` still validates and passes through.
    expect(files[1]).toMatchObject({ id: 66001, uuid: 'file-uuid-bbbb-0002' });
  });

  it('still exits 4 when a genuinely required key is missing (relaxation is scoped)', async () => {
    // `comments[].id` remains required — the fix widened files[], not comments[].
    const detail = await loadFixture<Record<string, unknown>>(
      'show-task-9020-comment-file-no-id.json',
    );
    const comments = detail['comments'] as Array<Record<string, unknown>>;
    const broken = {
      ...detail,
      comments: [{ ...comments[0], id: undefined }],
    };
    server.use(tasksShowHandlers.detailOk(9020, broken));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'edit',
      '9020',
      '--name',
      'Renamed',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/comments/);
  });
});

// ---------------------------------------------------------------------------
//  Introspect — R10 leaf is registered with the right meta
// ---------------------------------------------------------------------------

describe('freelo tasks edit — introspection', () => {
  it('--introspect lists `tasks edit` with output_schema and destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; destructive: boolean }>;
      };
    };
    const editCmd = env.data.commands.find((c) => c.name === 'tasks edit');
    expect(editCmd).toBeDefined();
    expect(editCmd!.output_schema).toBe('freelo.tasks.edit/v1');
    expect(editCmd!.destructive).toBe(false);
  });
});
