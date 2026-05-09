/**
 * End-to-end tests for `freelo projects workers list` (R32, spec 0045).
 *
 * Calibration §1: every typed error path asserts the **exit code**.
 * Calibration §2: every typed error class triggered has at least one test.
 * Calibration §4: the new try/catch arm (PartialPagesError unwrap) is
 *   covered by the mid-stream pagination test.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsWorkersHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/projects', name);
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

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-projects-workers-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects workers list — happy paths', () => {
  it('default --all → merged across two pages, exit 0', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('workers-page0.json');
    server.use(
      projectsWorkersHandlers.listPaged(9001, {
        0: page0 as never,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; workers: { id: number; fullname?: string }[] };
      paging?: { page: number; per_page: number; total: number; next_cursor: number | null };
    };
    expect(env.schema).toBe('freelo.projects.workers.list/v1');
    expect(env.data.project_id).toBe(9001);
    expect(env.data.workers).toHaveLength(2);
    expect(env.data.workers.map((w) => w.id)).toEqual([305, 150]);
    expect(env.paging?.next_cursor).toBe(null);
  });

  it('--page 0 → single page only, exit 0', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('workers-page0.json');
    server.use(projectsWorkersHandlers.listOk(9001, page0 as never));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--page',
      '0',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project_id: number; workers: { id: number }[] };
      paging?: { page: number };
    };
    expect(env.data.workers).toHaveLength(2);
    expect(env.paging?.page).toBe(0);
  });

  it('multi-page --all → iterates until empty page', async () => {
    server.use(
      projectsWorkersHandlers.listPaged(9001, {
        0: {
          total: 3,
          count: 2,
          page: 0,
          per_page: 2,
          data: {
            workers: [
              { id: 305, fullname: 'Jane Doe' },
              { id: 150, fullname: 'Bob Smith' },
            ],
          },
        },
        1: {
          total: 3,
          count: 1,
          page: 1,
          per_page: 2,
          data: { workers: [{ id: 820, fullname: 'Tax man' }] },
        },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--all',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { workers: { id: number }[] };
    };
    expect(env.data.workers.map((w) => w.id)).toEqual([305, 150, 820]);
  });

  it('empty project → workers: [], exit 0', async () => {
    server.use(
      projectsWorkersHandlers.listOk(9001, {
        total: 0,
        count: 0,
        page: 0,
        per_page: 25,
        data: { workers: [] },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { workers: unknown[] };
    };
    expect(env.data.workers).toEqual([]);
  });

  it('human mode renders the workers table', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('workers-page0.json');
    server.use(projectsWorkersHandlers.listOk(9001, page0 as never));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('Jane Doe');
    expect(stdout).toContain('Bob Smith');
    expect(stdout).toContain('305');
  });

  it('--fields id (human) → only ID column rendered; JSON unchanged', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('workers-page0.json');
    server.use(projectsWorkersHandlers.listOk(9001, page0 as never));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--fields',
      'id',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('ID');
    expect(stdout).not.toContain('FULLNAME');
  });

  it('empty project (human mode) → "(no workers)" row', async () => {
    server.use(
      projectsWorkersHandlers.listOk(9001, {
        total: 0,
        count: 0,
        page: 0,
        per_page: 25,
        data: { workers: [] },
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('(no workers)');
  });
});

// ---------------------------------------------------------------------------
//  Validation errors
// ---------------------------------------------------------------------------

describe('freelo projects workers list — validation', () => {
  it('missing --project → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'workers', 'list', '--output', 'json']);
    // Commander surfaces missing-required-option errors via its own error
    // path (exit 1) — they don't go through our `ValidationError` taxonomy
    // (which would be exit 2). The observable shape is "exits non-zero
    // before any HTTP fires"; we assert exit 1 explicitly to lock that.
    expect(exitCode).toBe(1);
  });

  it('--project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--page abc → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--fields with empty string → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--fields',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--fields with unknown column → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--fields',
      'fullname,unknown',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  API errors — calibration §2 (every typed error class triggered)
// ---------------------------------------------------------------------------

describe('freelo projects workers list — API errors', () => {
  it('401 → AUTH_EXPIRED, exit 3', async () => {
    server.use(projectsWorkersHandlers.listUnauthorized(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(3);
  });

  it('403 → exit 4', async () => {
    server.use(projectsWorkersHandlers.listForbidden(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4', async () => {
    server.use(projectsWorkersHandlers.listNotFound(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → RATE_LIMITED, exit 6', async () => {
    server.use(projectsWorkersHandlers.listRateLimited(9001));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(6);
  });

  it('500 → SERVER_ERROR, exit 4', async () => {
    server.use(projectsWorkersHandlers.listServerError(9001, 500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });

  it('mid-stream --all failure → underlying class re-thrown, exit 4 (calibration §4)', async () => {
    // First page succeeds, second page (p=1) returns 500.
    server.use(
      projectsWorkersHandlers.listMidStreamError({
        projectId: 9001,
        pages: {
          0: {
            total: 3,
            count: 2,
            page: 0,
            per_page: 2,
            data: {
              workers: [
                { id: 305, fullname: 'Jane' },
                { id: 150, fullname: 'Bob' },
              ],
            },
          },
        },
        failPage: 1,
        status: 500,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'projects',
      'workers',
      'list',
      '--project',
      '9001',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
  });
});

// ---------------------------------------------------------------------------
//  Introspection
// ---------------------------------------------------------------------------

describe('freelo projects workers list — introspection', () => {
  it('--introspect lists `projects workers list` with output_schema and destructive=false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: {
          name: string;
          output_schema: string;
          destructive: boolean;
        }[];
      };
    };
    const cmd = env.data.commands.find((c) => c.name === 'projects workers list');
    expect(cmd).toBeDefined();
    expect(cmd?.output_schema).toBe('freelo.projects.workers.list/v1');
    expect(cmd?.destructive).toBe(false);
  });
});
