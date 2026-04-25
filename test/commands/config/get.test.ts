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
    exitSpy,
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
  return {
    stdout: stdout.join(''),
    stderr: stderr.join(''),
    exitCode: getFirstExitCode() ?? 0,
  };
}

function parseFirstJson(text: string): unknown {
  const lines = text.split('\n').filter((l) => l.trim().startsWith('{'));
  for (const line of lines) {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      // try next line
    }
  }
  throw new Error(`No valid JSON line found in: ${JSON.stringify(text)}`);
}

describe('config get — happy paths', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-config-get-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.doMock('keytar', () => ({
      default: {
        getPassword: vi.fn().mockResolvedValue(null),
        setPassword: vi.fn(),
        deletePassword: vi.fn(),
      },
      getPassword: vi.fn().mockResolvedValue(null),
    }));

    vi.resetModules();

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('emits freelo.config.get/v1 for known key "profile"', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'get', 'profile', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { schema: string; data: { key: string } };
    expect(parsed.schema).toBe('freelo.config.get/v1');
    expect(parsed.data.key).toBe('profile');
    expect(exitCode).toBe(0);
  });

  it('returns correct value and source for output key', async () => {
    const { stdout } = await runCmd(['config', 'get', 'output', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { key: string; value: unknown; source: string; writable: boolean };
    };
    expect(parsed.data.key).toBe('output');
    expect(typeof parsed.data.value).toBe('string');
    expect(parsed.data.writable).toBe(true);
  });

  it('get apiKey returns "[redacted]" and writable: false', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'get', 'apiKey', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { key: string; value: unknown; writable: boolean };
    };
    expect(parsed.data.key).toBe('apiKey');
    expect(parsed.data.value).toBe('[redacted]');
    expect(parsed.data.writable).toBe(false);
    expect(exitCode).toBe(0);
  });
});

describe('config get — errors', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-config-get-err-${Date.now()}`);
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

    vi.doMock('keytar', () => ({
      default: { getPassword: vi.fn().mockResolvedValue(null) },
      getPassword: vi.fn().mockResolvedValue(null),
    }));

    vi.resetModules();

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 2 for unknown key', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'get', 'fooBar', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});
