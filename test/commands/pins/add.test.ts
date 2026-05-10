/**
 * End-to-end tests for `freelo pins add` (R44, spec 0058).
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { server, pinsHandlers } from '../../msw/handlers.js';

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
const PROJECT_ID = 100;

beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

beforeEach(async () => {
  testDir = join(tmpdir(), `freelo-pins-add-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  await mkdir(testDir, { recursive: true });
  vi.doMock('conf', () => ({
    default: vi.fn().mockImplementation(() => ({
      get path() {
        return join(testDir, 'config.json');
      },
      has: () => false,
      get store() {
        return {};
      },
      set store(_: unknown) {},
    })),
  }));
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

describe('freelo pins add — happy paths', () => {
  it('--request-id threads through (live + dry-run)', async () => {
    server.use(pinsHandlers.addOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout: liveOut, exitCode: liveExit } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
      '--output',
      'json',
    ]);
    expect(liveExit).toBe(0);
    expect((parseFirstJson(liveOut) as { request_id?: string }).request_id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );

    const { stdout: dryOut, exitCode: dryExit } = await runCli(run, [
      '--request-id',
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(dryExit).toBe(0);
    expect((parseFirstJson(dryOut) as { request_id?: string }).request_id).toBe(
      'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
    );
  });

  it('json --link only: wire body has link only (no title)', async () => {
    let captured: unknown;
    server.use(
      pinsHandlers.addOkWhenBody(PROJECT_ID, (body) => {
        captured = body;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['link'] === 'https://example.com/spec' &&
          !('title' in (body as Record<string, unknown>))
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://example.com/spec',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      schema: string;
      data: { applied_link: string; applied_title?: string; pin?: { id: number } };
    };
    expect(env.schema).toBe('freelo.pins.add/v1');
    expect(env.data.applied_link).toBe('https://example.com/spec');
    expect(env.data.applied_title).toBeUndefined();
    expect(env.data.pin?.id).toBe(99);
    expect(captured).toEqual({ link: 'https://example.com/spec' });
  });

  it('json --link + --title: wire body has both', async () => {
    let captured: unknown;
    server.use(
      pinsHandlers.addOkWhenBody(PROJECT_ID, (body) => {
        captured = body;
        return (
          typeof body === 'object' &&
          body !== null &&
          (body as Record<string, unknown>)['link'] === 'https://example.com/spec' &&
          (body as Record<string, unknown>)['title'] === 'Spec'
        );
      }),
    );
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://example.com/spec',
      '--title',
      'Spec',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    expect(captured).toEqual({ link: 'https://example.com/spec', title: 'Spec' });
    const env = parseFirstJson(stdout) as { data: { applied_title?: string } };
    expect(env.data.applied_title).toBe('Spec');
  });

  it('human happy: prints "Pinned ..." line', async () => {
    server.use(pinsHandlers.addOk(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://example.com/spec',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^Pinned "https:\/\/example\.com\/spec" to project #100 \(#99\)\.\s*$/);
  });

  it('--dry-run: no wire call; would.body matches', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://example.com/spec',
      '--dry-run',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      dry_run?: boolean;
      data: { would: { method: string; path: string; body: { link: string } } };
    };
    expect(env.dry_run).toBe(true);
    expect(env.data.would.method).toBe('POST');
    expect(env.data.would.path).toBe('/project/100/pinned-items');
    expect(env.data.would.body.link).toBe('https://example.com/spec');
  });

  it('--dry-run human: prints "(dry-run) Would POST ..."', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
      '--dry-run',
      '--output',
      'human',
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(
      /^\(dry-run\) Would POST \/project\/100\/pinned-items \(link="https:\/\/x"\)\.\s*$/,
    );
  });
});

describe('freelo pins add — validation', () => {
  it('missing --project: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'add', '--link', 'https://x']);
    expect(exitCode).toBe(2);
  });

  it('missing --link: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, ['pins', 'add', '--project', String(PROJECT_ID)]);
    expect(exitCode).toBe(2);
  });

  it('--link "" empty after trim: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      '   ',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--title "" empty after trim: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
      '--title',
      '   ',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project non-numeric: exit 2 (parseProjectFlag throws)', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      'abc',
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(2);
  });

  it('--project zero: exit 2', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      '0',
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(2);
  });
});

describe('freelo pins add — HTTP errors', () => {
  it('400 → exit 4 with --link/--project hint', async () => {
    server.use(pinsHandlers.addBadRequest(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { stderr, exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'invalid',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(4);
    const env = parseFirstJson(stderr) as { error: { hint_next?: string | null } };
    expect(env.error.hint_next).toMatch(/--link|--project/);
  });

  it('403 → exit 4', async () => {
    server.use(pinsHandlers.addForbidden(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(4);
  });

  it('404 → exit 4', async () => {
    server.use(pinsHandlers.addNotFound(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(4);
  });

  it('429 → exit 6', async () => {
    server.use(pinsHandlers.addRateLimited(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(6);
  });

  it('500 → exit 4', async () => {
    server.use(pinsHandlers.addServerError(PROJECT_ID, 500));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(4);
  });

  it('network → exit 5', async () => {
    server.use(pinsHandlers.addNetworkError(PROJECT_ID));
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runCli(run, [
      'pins',
      'add',
      '--project',
      String(PROJECT_ID),
      '--link',
      'https://x',
    ]);
    expect(exitCode).toBe(5);
  });
});

describe('freelo pins add — introspect', () => {
  it('--introspect: "pins add" with destructive: false', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout, exitCode } = await runCli(run, ['--introspect']);
    expect(exitCode).toBe(0);
    const env = parseFirstJson(stdout) as {
      data: { commands: Array<{ name: string; destructive: boolean }> };
    };
    const add = env.data.commands.find((c) => c.name === 'pins add');
    expect(add).toBeDefined();
    expect(add!.destructive).toBe(false);
  });
});
