import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: string | number | null) => {
    const code = Number(_code ?? 0);
    if (firstExitCode === undefined) firstExitCode = code;
    throw new Error(`EXIT:${code}`);
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

async function runCmd(
  argv: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();
  try {
    const { run } = await import('../../../src/bin/freelo.js');
    await run(['node', 'freelo', ...argv]);
  } catch {
    // swallow
  } finally {
    restore();
  }
  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: getFirstExitCode() ?? 0 };
}

function parseFirstJson(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      /* try next */
    }
  }
  throw new Error(`No valid JSON: ${JSON.stringify(text)}`);
}

function makeStoreWithProfiles(currentProfile: string | null = 'default') {
  let data: Record<string, unknown> = {
    schemaVersion: 2,
    currentProfile,
    profiles: {
      default: { email: 'user@example.cz', apiBaseUrl: 'https://api.freelo.io/v1' },
      ci: { email: 'agent@example.cz', apiBaseUrl: 'https://api.freelo.io/v1' },
    },
    defaults: {},
  };
  return {
    get data() {
      return data;
    },
    mock: () => ({
      get path() {
        return '/tmp/fake-config.json';
      },
      has: (key: string) => key in data,
      get store() {
        return { ...data };
      },
      set store(val: Record<string, unknown>) {
        data = { ...val };
      },
    }),
  };
}

describe('config use — switch profile', () => {
  let testDir: string;
  let store: ReturnType<typeof makeStoreWithProfiles>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-use-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    store = makeStoreWithProfiles('default');

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => store.mock());
      return { default: ConfMock };
    });

    vi.resetModules();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('switches profile and emits changed: true', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'use', 'ci', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { previous_profile: string; profile: string; changed: boolean };
    };
    expect(parsed.schema).toBe('freelo.config.use/v1');
    expect(parsed.data.profile).toBe('ci');
    expect(parsed.data.previous_profile).toBe('default');
    expect(parsed.data.changed).toBe(true);
    expect(exitCode).toBe(0);
  });

  it('is idempotent: switching to current profile emits changed: false', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'use', 'default', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { changed: boolean } };
    expect(parsed.data.changed).toBe(false);
    expect(exitCode).toBe(0);
  });

  it('exits with code 2 for unknown profile', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'use', 'nonexistent', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('makes no HTTP calls (no unhandled-request error from MSW)', async () => {
    // The MSW setup errors on unhandled requests. If config use made any HTTP calls
    // without a registered handler, this test would fail. Passing = no HTTP.
    const { exitCode } = await runCmd(['config', 'use', 'ci', '--output', 'json']);
    expect(exitCode).toBe(0);
  });
});
