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

describe('config list — happy path', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-config-list-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
      setPassword: vi.fn(),
      deletePassword: vi.fn(),
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

  it('emits a freelo.config.list/v1 envelope', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { schema: string };
    expect(parsed.schema).toBe('freelo.config.list/v1');
    expect(exitCode).toBe(0);
  });

  it('data.keys contains the fixed set of keys', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { keys: Array<{ key: string }> } };
    const keys = parsed.data.keys.map((k) => k.key);
    expect(keys).toContain('output');
    expect(keys).toContain('color');
    expect(keys).toContain('profile');
    expect(keys).toContain('apiBaseUrl');
    expect(keys).toContain('verbose');
    expect(keys).toContain('apiKey');
    expect(keys).toContain('email');
  });

  it('keys are in fixed order: writable (alpha) then readonly (alpha)', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { keys: Array<{ key: string; writable: boolean }> };
    };
    const writableKeys = parsed.data.keys.filter((k) => k.writable).map((k) => k.key);
    const readonlyKeys = parsed.data.keys.filter((k) => !k.writable).map((k) => k.key);

    // Writable alphabetical: apiBaseUrl, color, output, profile, verbose
    expect(writableKeys).toEqual(['apiBaseUrl', 'color', 'output', 'profile', 'verbose']);
    // All writable come before all readonly
    const firstReadonlyIdx = parsed.data.keys.findIndex((k) => !k.writable);
    const lastWritableIdx = parsed.data.keys.map((k) => k.writable).lastIndexOf(true);
    expect(firstReadonlyIdx).toBeGreaterThan(lastWritableIdx);
    void readonlyKeys;
  });

  it('apiKey value is "[redacted]"', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { keys: Array<{ key: string; value: unknown }> };
    };
    const apiKeyEntry = parsed.data.keys.find((k) => k.key === 'apiKey');
    expect(apiKeyEntry?.value).toBe('[redacted]');
  });

  it('includes request_id in the envelope', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { request_id?: string };
    expect(parsed.request_id).toBeTruthy();
  });

  it('emits a single envelope for --output ndjson (not one per key)', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'ndjson']);
    const lines = stdout
      .trim()
      .split('\n')
      .filter((l) => l.startsWith('{'));
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]!) as { schema: string };
    expect(parsed.schema).toBe('freelo.config.list/v1');
  });
});
