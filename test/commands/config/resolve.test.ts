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

describe('config resolve — flat mode (default)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-resolve-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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

  it('emits freelo.config.resolve/v1 envelope', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'resolve', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { schema: string };
    expect(parsed.schema).toBe('freelo.config.resolve/v1');
    expect(exitCode).toBe(0);
  });

  it('apiKey is "[redacted]" in the flat shape', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { apiKey: string } };
    expect(parsed.data.apiKey).toBe('[redacted]');
  });

  it('has_token is a boolean in the flat shape', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { has_token: boolean } };
    expect(typeof parsed.data.has_token).toBe('boolean');
  });

  it('includes request_id', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { request_id?: string };
    expect(parsed.request_id).toBeTruthy();
  });
});

describe('config resolve --show-source — annotated mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-resolve-src-${Date.now()}`);
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

  it('apiKey is annotated { value: "[redacted]", source } in show-source mode', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--show-source', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { apiKey: { value: string; source: string } };
    };
    expect(parsed.data.apiKey.value).toBe('[redacted]');
    expect(typeof parsed.data.apiKey.source).toBe('string');
  });

  it('profileSource has source: "derived" in show-source mode', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--show-source', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { profileSource: { value: string; source: string } };
    };
    expect(parsed.data.profileSource.source).toBe('derived');
  });

  it('output is annotated at the leaf level (mode and color separately)', async () => {
    const { stdout } = await runCmd(['config', 'resolve', '--show-source', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: {
        output: {
          mode: { value: string; source: string };
          color: { value: string; source: string };
        };
      };
    };
    expect(parsed.data.output.mode.value).toBeTruthy();
    expect(parsed.data.output.mode.source).toBeTruthy();
    expect(parsed.data.output.color.value).toBeTruthy();
    expect(parsed.data.output.color.source).toBeTruthy();
  });
});
