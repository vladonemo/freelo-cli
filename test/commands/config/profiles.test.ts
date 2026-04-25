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
  confData: Record<string, unknown> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();
  try {
    const { run } = await import('../../../src/bin/freelo.js');
    await run(['node', 'freelo', ...argv]);
  } catch {
    // swallow
  } finally {
    restore();
    void confData;
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

describe('config profiles — empty store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-profiles-empty-${Date.now()}`);
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

  it('emits freelo.config.profiles/v1 with empty profiles array', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'profiles', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { schema: string; data: { profiles: unknown[] } };
    expect(parsed.schema).toBe('freelo.config.profiles/v1');
    expect(parsed.data.profiles).toEqual([]);
    expect(exitCode).toBe(0);
  });
});

describe('config profiles — populated store', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-profiles-pop-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    const storeData = {
      schemaVersion: 2,
      currentProfile: 'ci',
      profiles: {
        default: { email: 'user@example.cz', apiBaseUrl: 'https://api.freelo.io/v1' },
        ci: { email: 'agent@example.cz', apiBaseUrl: 'https://api.freelo.io/v1' },
      },
      defaults: {},
    };

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in storeData,
        get store() {
          return { ...storeData };
        },
        set store(_: unknown) {},
      }));
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

  it('lists both profiles and marks ci as current', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'profiles', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: {
        current_profile: string;
        profiles: Array<{ name: string; current: boolean }>;
      };
    };
    expect(parsed.data.current_profile).toBe('ci');
    const ci = parsed.data.profiles.find((p) => p.name === 'ci');
    const def = parsed.data.profiles.find((p) => p.name === 'default');
    expect(ci?.current).toBe(true);
    expect(def?.current).toBe(false);
    expect(exitCode).toBe(0);
  });
});
