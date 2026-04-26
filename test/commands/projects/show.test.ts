import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, projectShowHandlers } from '../../msw/handlers.js';

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
    `freelo-projects-show-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo projects show — happy path', () => {
  it('emits freelo.projects.show/v1 envelope with project data, no workers when --with omitted', async () => {
    const project = await loadFixture<Record<string, unknown>>('show-project-42.json');
    server.use(projectShowHandlers.detailOk(42, project));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['projects', 'show', '42', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { project: { id: number; name: string }; workers?: unknown };
    };
    expect(env.schema).toBe('freelo.projects.show/v1');
    expect(env.data.project.id).toBe(42);
    expect(env.data.project.name).toBe('Site redesign');
    expect('workers' in env.data).toBe(false);
  });

  it('with --with workers, fetches paginated workers and merges across pages', async () => {
    const project = await loadFixture<Record<string, unknown>>('show-project-42.json');
    const page0 = await loadFixture<Record<string, unknown>>('show-workers-page0.json');
    const page1 = await loadFixture<Record<string, unknown>>('show-workers-page1.json');

    server.use(
      projectShowHandlers.detailOk(42, project),
      projectShowHandlers.workersPaged(42, { 0: page0 as never, 1: page1 as never }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'projects',
      'show',
      '42',
      '--with',
      'workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: {
        project: { id: number };
        workers: { id: number; fullname: string }[];
      };
    };
    expect(env.schema).toBe('freelo.projects.show/v1');
    expect(env.data.project.id).toBe(42);
    expect(env.data.workers).toHaveLength(3);
    expect(env.data.workers.map((w) => w.id)).toEqual([9, 17, 23]);
  });
});

describe('freelo projects show — error paths', () => {
  it('404 from /project/{id} maps to FREELO_API_ERROR with not-found hint and exit 4', async () => {
    server.use(projectShowHandlers.detailNotFound(99999));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'show',
      '99999',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.http_status).toBe(404);
    expect(env.error.hint_next).toMatch(/not found.*access/i);
  });

  it('403 from /project/{id} maps to FREELO_API_ERROR with permission hint and exit 4', async () => {
    server.use(projectShowHandlers.detailForbidden(7));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'show', '7', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next?: string };
    };
    expect(env.error.http_status).toBe(403);
    expect(env.error.hint_next).toMatch(/permission/i);
  });

  it('non-numeric <id> exits 2 with InvalidArgumentError before any HTTP call', async () => {
    // No MSW handler registered — if the CLI reaches a fetch, MSW errors as
    // unhandled and the test fails. That is the assertion: no HTTP fired.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'show', 'abc', '--output', 'json']);

    expect(exitCode).toBe(2);
    expect(stderr.toLowerCase()).toContain('positive integer');
  });

  it('non-positive <id> (zero) exits 2 before any HTTP call', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'show', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
    expect(stderr.toLowerCase()).toContain('positive integer');
  });

  it('--with labels exits 2 (validation) before any HTTP call', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'show',
      '42',
      '--with',
      'labels',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; hint_next?: string };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('VALIDATION_ERROR');
    expect(env.error.hint_next).toMatch(/workers/);
  });

  it('--with "" (empty) exits 2 with hint to omit the flag', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'show',
      '42',
      '--with',
      '',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string };
    };
    expect(env.error.code).toBe('VALIDATION_ERROR');
  });

  it('5xx from /project/{id} exits 4 with passthrough hint (not 404/403)', async () => {
    server.use(projectShowHandlers.detailServerError(42, 503));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, ['projects', 'show', '42', '--output', 'json']);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number; hint_next: string | null };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
    // rewriteApiHint must NOT inject a 404/403-flavored hint here; the
    // underlying FreeloApiError carries no hint of its own for 5xx, so
    // hint_next is null (or, if Freelo ever attaches one, must not look
    // like a 404 / 403 message).
    if (env.error.hint_next !== null) {
      expect(env.error.hint_next).not.toMatch(/not found/i);
      expect(env.error.hint_next).not.toMatch(/permission/i);
    }
  });

  it('mid-stream workers error during --with workers unwraps PartialPagesError to its inner cause', async () => {
    const project = await loadFixture<Record<string, unknown>>('show-project-42.json');
    const page0 = await loadFixture<Record<string, unknown>>('show-workers-page0.json');

    server.use(
      projectShowHandlers.detailOk(42, project),
      projectShowHandlers.workersMidStreamError({
        projectId: 42,
        pages: { 0: page0 as never },
        failPage: 1,
        status: 500,
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'show',
      '42',
      '--with',
      'workers',
      '--output',
      'json',
    ]);

    // Show is single-object — no partial envelope on stdout. The unwrapped
    // inner cause (FreeloApiError 500) bubbles through handleTopLevelError
    // for an exit 4, NOT a PartialPagesError-typed envelope.
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(500);
  });

  it('first-page workers error (no PartialPagesError wrapper) re-throws underlying error', async () => {
    const project = await loadFixture<Record<string, unknown>>('show-project-42.json');

    server.use(
      projectShowHandlers.detailOk(42, project),
      // Every workers page errors → fetchAllPages re-throws the underlying
      // FreeloApiError directly (no PartialPagesError wrapper because no pages
      // succeeded). This exercises the `throw err` branch in fetchAllWorkers
      // (show.ts line 205).
      projectShowHandlers.workersServerError(42, 503),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'projects',
      'show',
      '42',
      '--with',
      'workers',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      schema: string;
      error: { code: string; http_status: number };
    };
    expect(env.schema).toBe('freelo.error/v1');
    expect(env.error.code).toBe('SERVER_ERROR');
    expect(env.error.http_status).toBe(503);
  });
});
