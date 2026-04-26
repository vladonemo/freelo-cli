import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasklistsHandlers } from '../../msw/handlers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function loadFixture<T>(name: string): Promise<T> {
  const p = resolve(__dirname, '../../fixtures/tasklists', name);
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
    `freelo-tasklists-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo tasklists list — happy paths', () => {
  it('default scope (no --project) returns scope=all and project_id=null', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { scope: string; project_id: number | null; tasklists: unknown[] };
      paging: { page: number; per_page: number; total: number; next_cursor: number | null };
    };
    expect(env.schema).toBe('freelo.tasklists.list/v1');
    expect(env.data.scope).toBe('all');
    expect(env.data.project_id).toBeNull();
    expect(env.data.tasklists).toHaveLength(3);
    expect(env.paging.page).toBe(0);
    expect(env.paging.next_cursor).toBe(1);
    expect(env.paging.total).toBe(7);
  });

  it('--project 42 narrows to that project on the wire', async () => {
    const fixture = await loadFixture<Record<string, unknown>>('project-42-page0.json');
    server.use(tasklistsHandlers.allByProject(42, { 0: fixture as never }));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--project',
      '42',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { scope: string; project_id: number | null; tasklists: { id: number }[] };
      paging: { next_cursor: number | null };
    };
    expect(env.data.scope).toBe('project');
    expect(env.data.project_id).toBe(42);
    expect(env.data.tasklists).toHaveLength(2);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--page 1 maps to ?p=0 and returns the first page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--page',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { paging: { page: number } };
    expect(env.paging.page).toBe(0);
  });

  it('--page 99 past end returns empty data with next_cursor null', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--page',
      '99',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { tasklists: unknown[] };
      paging: { next_cursor: number | null };
    };
    expect(env.data.tasklists).toHaveLength(0);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--cursor 1 fetches that page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never, 1: page1 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--cursor',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as { paging: { page: number; next_cursor: number | null } };
    expect(env.paging.page).toBe(1);
    expect(env.paging.next_cursor).toBe(2);
  });

  it('--all in json mode returns one merged envelope', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      tasklistsHandlers.allOk({
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(1);
    const env = all[0] as {
      data: { tasklists: unknown[] };
      paging: { next_cursor: number | null };
    };
    expect(env.data.tasklists.length).toBe(3 + 3 + 1);
    expect(env.paging.next_cursor).toBeNull();
  });

  it('--all in ndjson mode emits one envelope per page', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('all-page1.json');
    const page2 = await loadFixture<Record<string, unknown>>('all-page2.json');
    server.use(
      tasklistsHandlers.allOk({
        0: page0 as never,
        1: page1 as never,
        2: page2 as never,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--all',
      '--output',
      'ndjson',
    ]);
    expect(exitCode).toBe(0);
    const all = parseAllJson(stdout);
    expect(all).toHaveLength(3);
    expect((all[0] as { paging: { page: number } }).paging.page).toBe(0);
    expect((all[2] as { paging: { next_cursor: number | null } }).paging.next_cursor).toBeNull();
  });

  it('empty result set returns tasklists: [] with paging.total === 0', async () => {
    server.use(
      tasklistsHandlers.allOk({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { tasklists: [] } },
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { tasklists: unknown[] };
      paging: { total: number; next_cursor: number | null };
    };
    expect(env.data.tasklists).toHaveLength(0);
    expect(env.paging.total).toBe(0);
    expect(env.paging.next_cursor).toBeNull();
  });
});

describe('freelo tasklists list — projection (--fields)', () => {
  it('--fields id,name projects records to those keys only', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--fields',
      'id,name',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { tasklists: Record<string, unknown>[] };
    };
    for (const t of env.data.tasklists) {
      expect(Object.keys(t).sort()).toEqual(['id', 'name']);
    }
  });
});

describe('freelo tasklists list — validation errors (exit 2)', () => {
  it('--project abc throws ValidationError (NOT InvalidArgumentError) → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--project',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; message: string; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toMatch(/--project/);
  });

  it('--project 0 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--project',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--project -1 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--project',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--page abc → exit 2 (parser throws ValidationError)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--page',
      'abc',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('--cursor -1 → exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--cursor',
      '-1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects --page + --all as mutually exclusive', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
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
      error: { code: string; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/Pick one/);
  });

  it('rejects --page + --cursor as mutually exclusive', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--page',
      '1',
      '--cursor',
      '1',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects --all + --cursor as mutually exclusive', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--all',
      '--cursor',
      '0',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it("--fields '' errors with EMPTY_FIELDS hint", async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--fields',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; hint_next: string | null } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/at least one field/);
  });

  it('--fields foo (unknown) errors before the API call', async () => {
    // No MSW handler — proves no HTTP call was made.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--fields',
      'foo',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { code: string; message: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.message).toContain('foo');
  });

  it('--fields project.name errors with NESTED_FIELDS_UNSUPPORTED hint', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--fields',
      'project.name',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as { error: { message: string; hint_next: string | null } };
    expect(env.error.message).toMatch(/Nested/);
    expect(env.error.hint_next).toMatch(/top-level/);
  });
});

describe('freelo tasklists list — HTTP error envelopes', () => {
  it('401 maps to AUTH_EXPIRED with exit 3', async () => {
    server.use(tasklistsHandlers.unauthorized());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(3);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('AUTH_EXPIRED');
  });

  it('5xx maps to SERVER_ERROR with retryable: true', async () => {
    server.use(tasklistsHandlers.serverError(503));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string; retryable: boolean } };
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.retryable).toBe(true);
  });

  it('404 maps to FREELO_API_ERROR with exit 4', async () => {
    server.use(tasklistsHandlers.notFound());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    // 404 surfaces as FREELO_API_ERROR via the client; code may vary.
    expect(['FREELO_API_ERROR', 'NOT_FOUND']).toContain(env.error.code);
  });

  it('malformed wrapper (missing tasklists key) → exit 4', async () => {
    server.use(tasklistsHandlers.malformedWrapper());
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'json']);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { code: string } };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });
});

// First-page error in --all: fetchAllPages re-throws the underlying error
// (NO PartialPagesError because no successful pages yet).
describe('freelo tasklists list — --all first-page error', () => {
  it('rethrows underlying error and emits an error envelope (no partial stdout)', async () => {
    server.use(
      tasklistsHandlers.allMidStreamError({
        pages: {},
        failPage: 0,
        status: 503,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    expect(stdout).toBe('');
    const errEnv = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.code).toBe('SERVER_ERROR');
  });
});

// Mid-stream --all error: emits partial envelope on stdout, error envelope on stderr.
describe('freelo tasklists list — mid-stream --all error', () => {
  it('emits the partial envelope on stdout and an error envelope on stderr (json)', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(
      tasklistsHandlers.allMidStreamError({
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, stderr, exitCode } = await runCli(run, [
      'tasklists',
      'list',
      '--all',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);

    const partial = parseFirstJson(stdout) as {
      schema: string;
      data: { tasklists: unknown[] };
      paging: { next_cursor: number | null };
      notice?: string;
    };
    expect(partial.schema).toBe('freelo.tasklists.list/v1');
    expect(partial.data.tasklists.length).toBe(3); // page 0 only
    expect(partial.paging.next_cursor).toBe(1);
    expect(partial.notice).toMatch(/Partial result/);

    const errEnv = parseFirstJson(stderr) as { schema: string; error: { code: string } };
    expect(errEnv.schema).toBe('freelo.error/v1');
    expect(errEnv.error.code).toBe('SERVER_ERROR');
  });
});

// Human-mode rendering — exercises the lazy cli-table3 path.
describe('freelo tasklists list — human-mode rendering', () => {
  it('renders successfully in --output human (default scope, single page)', async () => {
    const page0 = await loadFixture<Record<string, unknown>>('all-page0.json');
    server.use(tasklistsHandlers.allOk({ 0: page0 as never }));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stderr).not.toMatch(/freelo\.error/);
  });

  it('empty result renders the (no tasklists) row', async () => {
    server.use(
      tasklistsHandlers.allOk({
        0: { total: 0, count: 0, page: 0, per_page: 25, data: { tasklists: [] } },
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasklists', 'list', '--output', 'human']);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/no tasklists/);
  });
});

describe('freelo tasklists list — introspect', () => {
  it('appears in --introspect output with the expected flags', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect', '--output', 'json']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: {
        commands: Array<{ name: string; output_schema: string; flags: Array<{ name: string }> }>;
      };
    };
    const list = env.data.commands.find((c) => c.name === 'tasklists list');
    expect(list).toBeDefined();
    expect(list!.output_schema).toBe('freelo.tasklists.list/v1');
    const flagNames = list!.flags.map((f) => f.name).sort();
    expect(flagNames).toEqual(
      expect.arrayContaining(['--all', '--cursor', '--fields', '--page', '--project']),
    );
  });
});
