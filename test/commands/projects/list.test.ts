import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectsHandlers } from '../../msw/handlers.js';

vi.mock('keytar', () => ({
  default: { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() },
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

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

function parseAllJson(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

let testDir: string;

beforeEach(async () => {
  testDir = join(
    tmpdir(),
    `freelo-projects-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
  process.env['FREELO_NO_KEYCHAIN'] = '1';

  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.resetModules();
  delete process.env['FREELO_API_KEY'];
  delete process.env['FREELO_EMAIL'];
  delete process.env['FREELO_NO_KEYCHAIN'];
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
  try {
    await rm(testDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe('freelo projects list — scope dispatch', () => {
  it('--scope owned (default) returns entity_shape with_tasklists and synthesized paging', async () => {
    const owned = await loadFixture<unknown[]>('owned.json');
    server.use(projectsHandlers.ownedOk(owned));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['projects', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { entity_shape: string; scope: string; projects: unknown[] };
      paging: { page: number; per_page: number; total: number; next_cursor: number | null };
    };
    expect(env.schema).toBe('freelo.projects.list/v1');
    expect(env.data.entity_shape).toBe('with_tasklists');
    expect(env.data.scope).toBe('owned');
    expect(env.data.projects).toHaveLength(3);
    expect(env.paging.next_cursor).toBeNull();
    expect(env.paging.page).toBe(0);
    expect(env.paging.total).toBe(3);
  });

  it('--scope all returns entity_shape full', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(projectsHandlers.pagedOk('all', { 0: page0 as never }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { entity_shape: string; scope: string; projects: unknown[] };
      paging: { next_cursor: number | null };
    };
    expect(env.data.entity_shape).toBe('full');
    expect(env.data.scope).toBe('all');
    expect(env.paging.next_cursor).toBe(1);
  });

  it('--scope invited maps to /invited-projects', async () => {
    server.use(
      projectsHandlers.pagedOk('invited', {
        0: {
          total: 1,
          count: 1,
          page: 0,
          per_page: 25,
          data: { invited_projects: [{ id: 100, name: 'Inv' }] },
        },
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'invited',
      '--output',
      'json',
    ]);
    const env = parseFirstJson(stdout) as {
      data: { scope: string; projects: { id: number }[] };
    };
    expect(env.data.scope).toBe('invited');
    expect(env.data.projects[0]?.id).toBe(100);
  });
});

describe('freelo projects list — pagination flags', () => {
  it('--page 1 maps to ?p=0 and returns the first page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(projectsHandlers.pagedOk('all', { 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--page',
      '1',
      '--output',
      'json',
    ]);
    const env = parseFirstJson(stdout) as { paging: { page: number } };
    expect(env.paging.page).toBe(0);
  });

  it('--page 99 past end returns empty data with next_cursor null', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(projectsHandlers.pagedOk('all', { 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--page',
      '99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { projects: unknown[] };
      paging: { next_cursor: number | null };
    };
    expect(env.data.projects).toHaveLength(0);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--cursor 1 fetches that page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    server.use(projectsHandlers.pagedOk('all', { 0: page0 as never, 1: page1 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--cursor',
      '1',
      '--output',
      'json',
    ]);
    const env = parseFirstJson(stdout) as { paging: { page: number; next_cursor: number | null } };
    expect(env.paging.page).toBe(1);
    expect(env.paging.next_cursor).toBe(2);
  });

  it('--all in json mode returns one merged envelope', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      projectsHandlers.pagedOk('all', {
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--all',
      '--output',
      'json',
    ]);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(1);
    const env = all[0] as { data: { projects: unknown[] }; paging: { next_cursor: number | null } };
    expect(env.data.projects.length).toBe(2 + 2 + 1);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--all in ndjson mode emits one envelope per page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      projectsHandlers.pagedOk('all', {
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--all',
      '--output',
      'ndjson',
    ]);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(3);
    expect((all[0] as { paging: { page: number } }).paging.page).toBe(0);
    expect((all[2] as { paging: { next_cursor: number | null } }).paging.next_cursor).toBeNull();
  });
});

describe('freelo projects list — validation errors', () => {
  it('rejects --page + --all as mutually exclusive', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--page',
      '2',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; hint_next: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/Pick one/);
  });

  it('--scope owned + --cursor 1 errors with cursor-out-of-range', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'owned',
      '--cursor',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/unpaginated/);
  });

  it('--fields with an unknown name errors before the API call', async () => {
    // No MSW handler registered — proves no HTTP call was made.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--fields',
      'date_start',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('date_start');
  });

  it("--fields '' errors with EMPTY_FIELDS hint", async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--fields',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/at least one field/);
  });

  it('--fields state.id errors with NESTED_FIELDS_UNSUPPORTED hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--fields',
      'state.id',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { message: string } };
    expect(env.error.message).toMatch(/Nested/);
  });

  it('--page 0 is rejected by Commander parser (positive int only)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['projects', 'list', '--page', '0', '--output', 'json']);
    // Commander surfaces InvalidArgumentError with exit code 1.
    expect(exitCode).not.toBe(0);
  });
});

describe('freelo projects list — projection', () => {
  it('--fields id,name projects records to those keys only', async () => {
    const owned = await loadFixture<unknown[]>('owned.json');
    server.use(projectsHandlers.ownedOk(owned));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runCli(run, [
      'projects',
      'list',
      '--fields',
      'id,name',
      '--output',
      'json',
    ]);
    const env = parseFirstJson(stdout) as {
      data: { projects: Record<string, unknown>[] };
    };
    for (const p of env.data.projects) {
      expect(Object.keys(p).sort()).toEqual(['id', 'name']);
    }
  });
});

describe('freelo projects list — error envelopes', () => {
  it('401 maps to AUTH_EXPIRED with exit 3', async () => {
    server.use(projectsHandlers.unauthorized('owned'));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('5xx maps to SERVER_ERROR with retryable: true', async () => {
    server.use(projectsHandlers.serverError('owned', 503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; retryable: boolean } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.retryable).toBe(true);
  });
});

describe('freelo projects list — mid-stream --all error', () => {
  it('emits the partial envelope on stdout and an error envelope on stderr', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(
      projectsHandlers.allMidStreamError({
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'projects',
      'list',
      '--scope',
      'all',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);

    const partial = parseFirstJson(stdout) as {
      schema: string;
      data: { projects: unknown[] };
      paging: { next_cursor: number | null };
      notice?: string;
    };
    expect(partial.schema).toBe('freelo.projects.list/v1');
    expect(partial.data.projects.length).toBe(2); // page 0 only
    expect(partial.paging.next_cursor).toBe(1);
    expect(partial.notice).toMatch(/Partial result/);

    const errEnv = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.code).toBe('SERVER_ERROR');
  });
});

describe('freelo projects list — introspect', () => {
  it('appears in --introspect output with the expected flags', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; flags: Array<{ name: string }> }>;
      };
    };
    const list = env.data.commands.find((c) => c.name === 'projects list');
    expect(list).toBeDefined();
    expect(list!.output_schema).toBe('freelo.projects.list/v1');
    const flagNames = list!.flags.map((f) => f.name).sort();
    expect(flagNames).toEqual(
      expect.arrayContaining(['--all', '--cursor', '--fields', '--page', '--scope']),
    );
  });
});
