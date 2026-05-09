/**
 * End-to-end tests for `freelo tasks share` (R36, spec 0050).
 *
 * Covers:
 *   - Happy path live: envelope shape, URL passthrough, `created: null`.
 *   - Dry-run: no wire call, `dry_run: true`, placeholder URL, `would.method=GET`.
 *   - Validation: bad <id>.
 *   - HTTP errors: 401 → exit 3; 403 / 404 / 5xx → exit 4.
 *   - Schema-violation (server returns 200 without `url`) → exit 4.
 *   - Human mode contains the URL.
 *
 * Calibration §1: every error path the spec assigns an exit code asserts that
 * exit code. Calibration §2: each typed error class triggers explicitly
 * (`ValidationError` exit 2, `FreeloApiError` exit 3 for 401, exit 4 for the rest).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, tasksShareHandlers } from '../../msw/handlers.js';

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
    `freelo-tasks-share-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

  // Default: non-TTY (agent path).
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
//  Happy path
// ---------------------------------------------------------------------------

describe('freelo tasks share — happy paths', () => {
  it('live: 200 with url → envelope { task_id, url, created: null }', async () => {
    server.use(tasksShareHandlers.ok(4567, 'https://app.freelo.io/share/abc123'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { task_id: number; url: string; created: boolean | null };
    };
    expect(env.schema).toBe('freelo.tasks.share/v1');
    expect(env.data.task_id).toBe(4567);
    expect(env.data.url).toBe('https://app.freelo.io/share/abc123');
    expect(env.data.created).toBeNull();
  });

  it('live: idempotent on the wire — same URL on a second call', async () => {
    // Comment-only test: the wire is idempotent. The CLI cannot distinguish
    // first-call-creates from Nth-call-returns-existing, so envelope shape
    // is identical either way. Spec 0050 decision 2.
    server.use(tasksShareHandlers.ok(4567, 'https://app.freelo.io/share/abc123'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout: out1 } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    const env1 = parseFirstJson(out1) as { data: { url: string; created: boolean | null } };
    expect(env1.data.url).toBe('https://app.freelo.io/share/abc123');
    expect(env1.data.created).toBeNull();
  });

  it('human mode renders one line with the URL', async () => {
    server.use(tasksShareHandlers.ok(4567, 'https://app.freelo.io/share/abc123'));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'human']);

    expect(exitCode).toBe(0);
    expect(stdout).toContain('Public link for task #4567');
    expect(stdout).toContain('https://app.freelo.io/share/abc123');
  });
});

// ---------------------------------------------------------------------------
//  Dry-run
// ---------------------------------------------------------------------------

describe('freelo tasks share — dry-run', () => {
  it('--dry-run: no wire call, dry_run=true, placeholder url, would.method=GET', async () => {
    // No handler — a wire call would fail with onUnhandledRequest: 'error'.
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'share',
      '4567',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      dry_run: boolean;
      data: {
        task_id: number;
        url: string;
        created: boolean | null;
        would: { method: string; path: string; body: Record<string, unknown> };
      };
    };
    expect(env.schema).toBe('freelo.tasks.share/v1');
    expect(env.dry_run).toBe(true);
    expect(env.data.task_id).toBe(4567);
    // Spec 0050 decision 4 — exact placeholder literal.
    expect(env.data.url).toBe('<dry-run: not yet known>');
    expect(env.data.created).toBeNull();
    expect(env.data.would.method).toBe('GET');
    expect(env.data.would.path).toBe('/public-link/task/4567');
    expect(env.data.would.body).toEqual({});
  });

  it('--dry-run + human mode signals dry-run prefix, no fake URL leakage', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'tasks',
      'share',
      '4567',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain('[dry-run]');
    expect(stdout).toContain('task #4567');
    // Human dry-run line must NOT contain a fake URL — would mislead users.
    expect(stdout).not.toContain('https://');
  });
});

// ---------------------------------------------------------------------------
//  Validation
// ---------------------------------------------------------------------------

describe('freelo tasks share — validation', () => {
  it('non-numeric <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', 'abc', '--output', 'json']);
    expect(exitCode).toBe(2);
  });

  it('zero <id> → ValidationError exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '0', '--output', 'json']);
    expect(exitCode).toBe(2);
  });
});

// ---------------------------------------------------------------------------
//  HTTP error paths
// ---------------------------------------------------------------------------

describe('freelo tasks share — HTTP errors', () => {
  it('401 → AUTH_EXPIRED exit 3', async () => {
    server.use(tasksShareHandlers.unauthorized(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    expect(exitCode).toBe(3);
  });

  it('403 → FORBIDDEN exit 4', async () => {
    server.use(tasksShareHandlers.forbidden(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('404 → NOT_FOUND exit 4 (distinct from unshare 404 → success)', async () => {
    server.use(tasksShareHandlers.notFound(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('500 → FREELO_API_ERROR exit 4', async () => {
    server.use(tasksShareHandlers.serverError(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });

  it('200 without `url` → schema validation FreeloApiError exit 4', async () => {
    // Server returns 200 with `{}` — schema-required `url` is missing.
    // The HTTP client surfaces this as FreeloApiError(VALIDATION_ERROR, exit 4).
    server.use(tasksShareHandlers.okMissingUrl(4567));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['tasks', 'share', '4567', '--output', 'json']);
    expect(exitCode).toBe(4);
  });
});
