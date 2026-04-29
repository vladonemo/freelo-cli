/**
 * End-to-end tests for `freelo notifications unread` (R28, spec 0040).
 *
 * Smaller than read.test.ts because there is no `--all-unread` flag.
 * Covers: single id, batch ids, --ids, --stdin, --dry-run, mutex, server
 * errors. Exit-code assertions per Calibration §1/§2.
 */

import { Readable } from 'node:stream';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { server, notificationsHandlers } from '../../msw/handlers.js';

const API_BASE = 'https://api.freelo.io/v1';

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

function parseAllJsonLines(text: string): Record<string, unknown>[] {
  return text
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

function pipeStdin(text: string): () => void {
  const original = process.stdin;
  const stream = Readable.from([text]);
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
    `freelo-notifs-unread-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe('freelo notifications unread — happy paths', () => {
  it('single positional id: single envelope, posted: true, exit 0', async () => {
    server.use(notificationsHandlers.markUnreadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { notification_id: number; posted: boolean };
    };
    expect(env.schema).toBe('freelo.notifications.unread/v1');
    expect(env.data.notification_id).toBe(42);
    expect(env.data.posted).toBe(true);
  });

  it('multiple positional ids: NDJSON envelopes, exit 0', async () => {
    server.use(notificationsHandlers.markUnreadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '43',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect(lines.every((l) => (l['schema'] as string) === 'freelo.notifications.unread/v1')).toBe(
      true,
    );
  });

  it('--ids "1,2" produces two envelopes', async () => {
    server.use(notificationsHandlers.markUnreadOk());

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '--ids',
      '1,2',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
  });

  it('--stdin NDJSON: two envelopes with line_index, exit 0', async () => {
    server.use(notificationsHandlers.markUnreadOk());
    const restore = pipeStdin('{"id": 42}\n{"id": 43}\n');
    try {
      const { run } = await import('../../../src/bin/freelo.js');
      const { stdout, exitCode } = await runCli(run, [
        'notifications',
        'unread',
        '--stdin',
        '--output',
        'json',
      ]);

      expect(exitCode).toBe(0);
      const lines = parseAllJsonLines(stdout);
      expect(lines).toHaveLength(2);
      expect((lines[0]?.data as { line_index: number }).line_index).toBe(0);
    } finally {
      restore();
    }
  });

  it('--dry-run: no POST, dry_run + would echoed, exit 0', async () => {
    let postCount = 0;
    server.use(
      http.post(`${API_BASE}/notification/:id/mark-unread`, () => {
        postCount += 1;
        return HttpResponse.json({ result: 'success' });
      }),
    );

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '--dry-run',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(0);
    expect(postCount).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run: boolean;
      data: { would: { method: string; path: string } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.path).toBe('/notification/42/mark-unread');
  });
});

describe('freelo notifications unread — validation', () => {
  it('positional + --ids → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '--ids',
      '43',
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

  it('<id 0> → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notifications', 'unread', '0', '--output', 'json']);

    expect(exitCode).toBe(2);
  });

  it('<id abc> → ValidationError, exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['notifications', 'unread', 'abc', '--output', 'json']);

    expect(exitCode).toBe(2);
  });

  it('--all-unread is rejected (flag does not exist on unread)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '--all-unread',
      '--output',
      'json',
    ]);

    // Commander unknown-option behavior surfaces as exit 1 (CommanderError).
    // Either 1 or 2 is acceptable here — the contract is "rejected".
    expect(exitCode).not.toBe(0);
  });
});

describe('freelo notifications unread — HTTP errors', () => {
  it('single-id 404 → top-level error envelope on stderr, exit 4', async () => {
    server.use(notificationsHandlers.markUnreadNotFound(42));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as {
      error: { code: string; http_status: number };
    };
    expect(env.error.code).toBe('NOT_FOUND');
    expect(env.error.http_status).toBe(404);
  });

  it('multi-id mode: 5xx → per-id error env, exit 4', async () => {
    server.use(notificationsHandlers.markUnreadServerError(500));

    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'notifications',
      'unread',
      '42',
      '43',
      '--output',
      'json',
    ]);

    expect(exitCode).toBe(4);
    const lines = parseAllJsonLines(stdout);
    expect(lines).toHaveLength(2);
    expect((lines[0] as { schema: string }).schema).toBe('freelo.error/v1');
    expect((lines[1] as { schema: string }).schema).toBe('freelo.error/v1');
  });
});
