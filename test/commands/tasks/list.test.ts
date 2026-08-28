import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasks', name);
  const raw = await readFile(p, 'utf8');
  return JSON.parse(raw) as T;
}

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

function parseAllJson(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
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
    `freelo-tasks-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
//  Happy paths (8)
// ---------------------------------------------------------------------------
describe('freelo tasks list — happy paths', () => {
  it('1. no flags → /all-tasks page 0; envelope and applied_filters {}', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasksHandlers.allTasksOk({ 0: page0 as never }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        endpoint: string;
        entity_shape: string;
        applied_filters: Record<string, unknown>;
        tasks: unknown[];
      };
      paging: { page: number; next_cursor: number | null };
    };
    expect(env.schema).toBe('freelo.tasks.list/v1');
    expect(env.data.endpoint).toBe('all-tasks');
    expect(env.data.entity_shape).toBe('task_full');
    expect(env.data.applied_filters).toEqual({});
    expect(env.data.tasks).toHaveLength(3);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBe(1);
  });

  it('2. --project + --label → URL has projects_ids[]/with_labels[] (no singular with_label)', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--project',
      '43',
      '--label',
      'bug',
      '--label',
      'p1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('projects_ids%5B%5D=42');
    expect(capturedUrl).toContain('projects_ids%5B%5D=43');
    expect(capturedUrl).toContain('with_labels%5B%5D=bug');
    expect(capturedUrl).toContain('with_labels%5B%5D=p1');
    expect(capturedUrl).not.toMatch(/with_label=/);
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { projects: number[]; labels: string[] } };
    };
    expect(env.data.applied_filters.projects).toEqual([42, 43]);
    expect(env.data.applied_filters.labels).toEqual(['bug', 'p1']);
  });

  it('3. --project + --tasklist → unpaginated route, defaulted to board order (spec 0060)', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    let capturedUrl = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/project/42/tasklist/101/tasks', ({ request }) => {
        capturedUrl = new URL(request.url).toString();
        return HttpResponse.json(items);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    // Issue #108: with neither --order-by nor --order, the CLI must ask for the
    // tasklist's manual/drag board order explicitly instead of sending a bare
    // path and inheriting an unstated server default.
    expect(capturedUrl).toContain('order_by=priority');
    expect(capturedUrl).toContain('order=asc');
    const env = parseFirstJson(stdout) as {
      data: {
        endpoint: string;
        entity_shape: string;
        applied_filters: Record<string, unknown>;
        tasks: unknown[];
      };
      paging: { next_cursor: number | null };
    };
    expect(env.data.endpoint).toBe('tasklist-tasks');
    expect(env.data.entity_shape).toBe('task_summary');
    expect(env.data.tasks).toHaveLength(2);
    expect(env.paging.next_cursor).toBeNull();
    // applied_filters stays a faithful echo of *user*-supplied flags only, so
    // the envelope is byte-identical for callers that never passed a sort flag.
    expect(env.data.applied_filters).not.toHaveProperty('order_by');
    expect(env.data.applied_filters).not.toHaveProperty('order');
  });

  it('4. --order-by/--order forwarded on per-tasklist route', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    let capturedUrl = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/project/42/tasklist/101/tasks', ({ request }) => {
        capturedUrl = new URL(request.url).toString();
        return HttpResponse.json(items);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--order-by',
      'name',
      '--order',
      'desc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('order_by=name');
    expect(capturedUrl).toContain('order=desc');
    // Regression guard for spec 0060: the injected default must never override
    // an explicit user flag.
    expect(capturedUrl).not.toContain('order_by=priority');
    expect(capturedUrl).not.toContain('order=asc');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { order_by: string; order: string } };
    };
    expect(env.data.applied_filters.order_by).toBe('name');
    expect(env.data.applied_filters.order).toBe('desc');
  });

  it('4a. --order-by alone on per-tasklist route → no default injected for either half', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    let capturedUrl = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/project/42/tasklist/101/tasks', ({ request }) => {
        capturedUrl = new URL(request.url).toString();
        return HttpResponse.json(items);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--order-by',
      'name',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    // Spec 0060 / decision 4: partial supply suppresses the default for *both*
    // halves, so this request is byte-identical to pre-0060 behavior.
    expect(capturedUrl).toContain('order_by=name');
    expect(capturedUrl).not.toMatch(/[?&]order=/);
    expect(capturedUrl).not.toContain('order_by=priority');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: Record<string, unknown> };
    };
    expect(env.data.applied_filters.order_by).toBe('name');
    expect(env.data.applied_filters).not.toHaveProperty('order');
  });

  it('4b. --order alone on per-tasklist route → no default order_by injected', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    let capturedUrl = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/project/42/tasklist/101/tasks', ({ request }) => {
        capturedUrl = new URL(request.url).toString();
        return HttpResponse.json(items);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--order',
      'desc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('order=desc');
    expect(capturedUrl).not.toContain('order_by');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: Record<string, unknown> };
    };
    expect(env.data.applied_filters.order).toBe('desc');
    expect(env.data.applied_filters).not.toHaveProperty('order_by');
  });

  it('4c. /all-tasks with no order flags → still sends no order_by (default is scoped)', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    // Spec 0060 §3: the board-order default belongs to the per-tasklist route
    // only. /all-tasks keeps its own documented default (date_add).
    expect(capturedUrl).not.toContain('order_by');
    expect(capturedUrl).not.toMatch(/[?&]order=/);
  });

  // --- spec 0061: `due_date` is the fifth accepted --order-by value ---------
  // Both listing routes document it in docs/api/freelo-api.yaml (tasklist route
  // line 1522, /all-tasks line 1639), so both halves are pinned here.

  it('4d. --order-by due_date on per-tasklist route → forwarded, no 0060 default injected', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    let capturedUrl = '';
    const { http, HttpResponse } = await import('msw');
    server.use(
      http.get('https://api.freelo.io/v1/project/42/tasklist/101/tasks', ({ request }) => {
        capturedUrl = new URL(request.url).toString();
        return HttpResponse.json(items);
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--order-by',
      'due_date',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('order_by=due_date');
    // Spec 0060 interaction: supplying only --order-by suppresses the injected
    // default for BOTH halves. `due_date` must behave exactly like `name` here.
    expect(capturedUrl).not.toMatch(/[?&]order=/);
    expect(capturedUrl).not.toContain('order_by=priority');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { order_by: string } };
    };
    expect(env.data.applied_filters.order_by).toBe('due_date');
    expect(env.data.applied_filters).not.toHaveProperty('order');
  });

  it('4e. --order-by due_date --order asc on /all-tasks → both forwarded and echoed', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--order-by',
      'due_date',
      '--order',
      'asc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('order_by=due_date');
    expect(capturedUrl).toContain('order=asc');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { order_by: string; order: string } };
    };
    expect(env.data.applied_filters.order_by).toBe('due_date');
    expect(env.data.applied_filters.order).toBe('asc');
  });

  // The rejection path for an unknown --order-by value (including the copy that
  // enumerates all five) lives with the other exit-2 cases: see test 24a in
  // `freelo tasks list — validation errors`.

  it('5. --worker + --project + --tasklist falls through to /all-tasks', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--worker',
      '7',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('worker_id=7');
    expect(capturedUrl).toContain('projects_ids%5B%5D=42');
    expect(capturedUrl).toContain('tasklists_ids%5B%5D=101');
    const env = parseFirstJson(stdout) as {
      data: { endpoint: string; applied_filters: { worker: number } };
    };
    expect(env.data.endpoint).toBe('all-tasks');
    expect(env.data.applied_filters.worker).toBe(7);
  });

  it('6. --all in json mode merges 3 pages → tasks.length 7', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      tasksHandlers.allTasksOk({
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'list', '--all', '--output', 'json']);
    expect(exitCode).toBe(0);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(1);
    const env = all[0] as { data: { tasks: unknown[] }; paging: { next_cursor: number | null } };
    expect(env.data.tasks.length).toBe(7);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('7. --all in ndjson mode emits one envelope per page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      tasksHandlers.allTasksOk({
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--all',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(0);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(3);
    expect((all[2] as { paging: { next_cursor: number | null } }).paging.next_cursor).toBeNull();
  });

  it('8. --no-due → URL contains no_due_date=true; applied_filters.no_due === true', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--no-due',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('no_due_date=true');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { no_due: boolean } } };
    expect(env.data.applied_filters.no_due).toBe(true);
  });
});

// ---------------------------------------------------------------------------
//  Date / range / search behaviors (5)
// ---------------------------------------------------------------------------
describe('freelo tasks list — date/range/search', () => {
  it('9. --due-from + --due-to → bracketed query encoding', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--due-from',
      '2026-04-01',
      '--due-to',
      '2026-04-30',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('due_date_range%5Bdate_from%5D=2026-04-01');
    expect(capturedUrl).toContain('due_date_range%5Bdate_to%5D=2026-04-30');
    const env = parseFirstJson(stdout) as {
      data: { applied_filters: { due_from?: string; due_to?: string } };
    };
    expect(env.data.applied_filters.due_from).toBe('2026-04-01');
    expect(env.data.applied_filters.due_to).toBe('2026-04-30');
  });

  it('10. --search redesign → URL contains search_query=redesign', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--search',
      'redesign',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('search_query=redesign');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { search?: string } } };
    expect(env.data.applied_filters.search).toBe('redesign');
  });

  it('11. --state 1 → URL contains state_id=1', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--state',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('state_id=1');
    const env = parseFirstJson(stdout) as { data: { applied_filters: { state?: number } } };
    expect(env.data.applied_filters.state).toBe(1);
  });

  it('12. --without-label wontfix → URL contains without_label=wontfix', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--without-label',
      'wontfix',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('without_label=wontfix');
  });

  it('13. --finished-overdue --tasklist 101 routes to /all-tasks with tasklists_ids[]=101 + finished_overdue=true', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--finished-overdue',
      '--tasklist',
      '101',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('tasklists_ids%5B%5D=101');
    expect(capturedUrl).toContain('finished_overdue=true');
    const env = parseFirstJson(stdout) as { data: { endpoint: string } };
    expect(env.data.endpoint).toBe('all-tasks');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors (12)  — Calibration §2 requires exit code on each
// ---------------------------------------------------------------------------
describe('freelo tasks list — validation errors', () => {
  function expectValidationError(stderr: string): void {
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  }

  it('14. --project abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('15. --project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('16. --project -1 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('17. --tasklist abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--tasklist',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('18. --worker 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--worker',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('19. --page abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('20. --cursor -1 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--cursor',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('21. --page 2 --all → exit 2 with mutex hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--page',
      '2',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next?: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next ?? '').toMatch(/Pick one/i);
  });

  it('22. --no-due --due-from → exit 2 with combined hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--no-due',
      '--due-from',
      '2026-04-01',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next?: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next ?? '').toMatch(/Pick either --no-due or/i);
  });

  it('23. --due-from 2026/04/01 → exit 2 with YYYY-MM-DD hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--due-from',
      '2026/04/01',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next?: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next ?? '').toMatch(/YYYY-MM-DD|ISO date/i);
  });

  it('24. --due-from 2026-13-01 → exit 2 (invalid date)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--due-from',
      '2026-13-01',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
  });

  it('24a. --order-by duedate → exit 2, message lists all five valid values (spec 0061)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--order-by',
      'duedate',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    expectValidationError(stderr);
    // Guards the error/help copy against drifting out of sync with
    // TASK_ORDER_BY_VALUES — the allow-list and the rendered string share a
    // single source, so a future value added to one shows up in both or this
    // test fails.
    const env = parseFirstJson(stderr) as { error: { message: string } };
    for (const v of ['priority', 'name', 'date_add', 'date_edited_at', 'due_date']) {
      expect(env.error.message).toContain(v);
    }
  });

  it('25. --search + --project + --tasklist (no other filter) → exit 2 with drop-search hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--search',
      'redesign',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next?: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next ?? '').toMatch(/drop --(project|search)/i);
  });
});

// ---------------------------------------------------------------------------
//  Field projection errors (3)
// ---------------------------------------------------------------------------
describe('freelo tasks list — field projection', () => {
  it('26. --fields "" → exit 2 (EMPTY_FIELDS)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--fields',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('27. --fields foo → exit 2 (UNKNOWN_FIELD)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--fields',
      'foo',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/Unknown field 'foo'/);
  });

  it('28. --fields state on per-tasklist route (task_summary, no state field) → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--fields',
      'state',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/task_summary/);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths (5)  — Calibration §1: each typed error class has a test
// ---------------------------------------------------------------------------
describe('freelo tasks list — HTTP error paths', () => {
  it('29. 401 → exit 3', async () => {
    server.use(tasksHandlers.unauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('30. 5xx → exit 4', async () => {
    server.use(tasksHandlers.serverError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toMatch(/SERVER_ERROR|FREELO_API_ERROR|UNKNOWN_API_ERROR/);
  });

  it('31. 429 (budget exhausted, 3 attempts) → exit 6, RATE_LIMITED', async () => {
    server.use(tasksHandlers.rateLimited());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(6);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('RATE_LIMITED');
  }, 30_000);

  it('32. network error → exit 5, NETWORK_ERROR', async () => {
    server.use(tasksHandlers.networkError());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(5);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('NETWORK_ERROR');
  });

  it('33. malformed wrapper (data missing tasks key) → exit 4, FreeloApiError(VALIDATION_ERROR)', async () => {
    server.use(tasksHandlers.malformedWrapper());
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode, stderr } = await runCli(run, ['tasks', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
//  Human renderer + misc branches (calibration §4 — every catch arm + mode)
// ---------------------------------------------------------------------------
describe('freelo tasks list — human + misc branches', () => {
  it('--output human renders a table for /all-tasks', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasksHandlers.allTasksOk({ 0: page0 as never }));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ID');
    expect(stdout).toContain('NAME');
    expect(stdout).toContain('Wire the home page');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  it('--output human renders a table for the per-tasklist route', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    server.use(tasksHandlers.tasklistTasksOk(42, 101, items));
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('NAME');
    expect(stdout).toContain('Refactor header');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  it('--output human empty result → "(no tasks)" body row', async () => {
    server.use(
      tasksHandlers.allTasksOk({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { tasks: [] } } as never,
      }),
    );
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no tasks)');
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  it('--cursor 1 on per-tasklist route → exit 2 (CURSOR_OUT_OF_RANGE-style)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--cursor',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next?: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next ?? '').toMatch(/--cursor 0/);
  });

  it('--label "" → exit 2 (empty-string rejected by collector)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'list', '--label', '', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('--all in ndjson with mid-stream error: pages already streamed, error follows', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(
      tasksHandlers.allMidStreamError({
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--all',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(4);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(1);
    expect((all[0] as { paging: { page: number } }).paging.page).toBe(0);
  });

  it('--page 1 maps to ?p=0 on the wire', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    let capturedUrl = '';
    server.use(
      tasksHandlers.allTasksByQuery((u) => {
        capturedUrl = u.toString();
        return true;
      }, page0 as never),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'list', '--page', '1', '--output', 'json']);
    expect(exitCode).toBe(0);
    expect(capturedUrl).toContain('p=0');
  });

  it('--cursor 0 + --project + --tasklist works (unpaginated route accepts cursor 0)', async () => {
    const items = await loadFixture<Array<Record<string, unknown>>>('tasklist-tasks.json');
    server.use(tasksHandlers.tasklistTasksOk(42, 101, items));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'tasks',
      'list',
      '--project',
      '42',
      '--tasklist',
      '101',
      '--cursor',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
  });
});

// ---------------------------------------------------------------------------
//  Mid-stream --all errors (2)
// ---------------------------------------------------------------------------
describe('freelo tasks list — mid-stream --all errors', () => {
  it('34. first-page error during --all (no PartialPagesError wrap) → exit 4', async () => {
    server.use(tasksHandlers.serverError(500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'list', '--all', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('35. mid-stream error during --all (json mode) → partial envelope on stdout, exit 4', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(
      tasksHandlers.allMidStreamError({
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'list', '--all', '--output', 'json']);
    expect(exitCode).toBe(4);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(1);
    const env = all[0] as { data: { tasks: unknown[] }; notice?: string };
    expect(env.data.tasks).toHaveLength(3);
    expect(env.notice ?? '').toMatch(/Partial result/);
  });
});
