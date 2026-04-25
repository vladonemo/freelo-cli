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

describe('config set — happy paths (defaults scope)', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-set-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    data = { schemaVersion: 2, currentProfile: null, profiles: {}, defaults: {} };

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          data = { ...val };
        },
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

  it('sets output and emits freelo.config.set/v1', async () => {
    const { stdout, exitCode } = await runCmd([
      'config',
      'set',
      'output',
      'json',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { key: string; value: string; scope: string };
    };
    expect(parsed.schema).toBe('freelo.config.set/v1');
    expect(parsed.data.key).toBe('output');
    expect(parsed.data.value).toBe('json');
    expect(parsed.data.scope).toBe('defaults');
    expect(exitCode).toBe(0);
  });

  it('sets color', async () => {
    const { stdout, exitCode } = await runCmd([
      'config',
      'set',
      'color',
      'never',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as { data: { key: string; value: string } };
    expect(parsed.data.key).toBe('color');
    expect(parsed.data.value).toBe('never');
    expect(exitCode).toBe(0);
  });

  it('sets verbose "2" and value coerces to string "2" in envelope', async () => {
    const { stdout, exitCode } = await runCmd([
      'config',
      'set',
      'verbose',
      '2',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as { data: { key: string; value: string } };
    expect(parsed.data.key).toBe('verbose');
    // verbose is emitted as string on the wire (§7 #6)
    expect(parsed.data.value).toBe('2');
    expect(exitCode).toBe(0);
  });

  it('idempotent write: previous_value equals value when already set', async () => {
    // Set twice
    await runCmd(['config', 'set', 'output', 'json', '--output', 'json']);
    const { stdout } = await runCmd(['config', 'set', 'output', 'json', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { previous_value: string; value: string } };
    expect(parsed.data.previous_value).toBe('json');
    expect(parsed.data.value).toBe('json');
  });

  it('previous_value is null when key was not previously set', async () => {
    const { stdout } = await runCmd(['config', 'set', 'color', 'always', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as { data: { previous_value: unknown } };
    expect(parsed.data.previous_value).toBeNull();
  });
});

describe('config set — profile key (currentProfile scope)', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-set-profile-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    data = {
      schemaVersion: 2,
      currentProfile: 'default',
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
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          data = { ...val };
        },
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

  it('sets profile to known existing profile', async () => {
    const { stdout, exitCode } = await runCmd([
      'config',
      'set',
      'profile',
      'ci',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as { data: { key: string; value: string } };
    expect(parsed.data.key).toBe('profile');
    expect(parsed.data.value).toBe('ci');
    expect(exitCode).toBe(0);
  });

  it('exits with code 2 when target profile does not exist', async () => {
    const { exitCode, stderr } = await runCmd([
      'config',
      'set',
      'profile',
      'nonexistent',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});

describe('config set — apiBaseUrl (profile scope)', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-set-url-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    data = {
      schemaVersion: 2,
      currentProfile: 'default',
      profiles: {
        default: { email: 'user@example.cz', apiBaseUrl: 'https://api.freelo.io/v1' },
      },
      defaults: {},
    };

    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          data = { ...val };
        },
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

  it('sets apiBaseUrl with scope: profile', async () => {
    const { stdout, exitCode } = await runCmd([
      'config',
      'set',
      'apiBaseUrl',
      'https://staging.freelo.io/v1',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as { data: { scope: string; profile: string } };
    expect(parsed.data.scope).toBe('profile');
    expect(parsed.data.profile).toBe('default');
    expect(exitCode).toBe(0);
  });
});

describe('config set — errors', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-set-err-${Date.now()}`);
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

  it('exits with code 2 for unknown key', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'set', 'fooBar', '1', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('exits with code 2 for read-only key (apiKey)', async () => {
    const { exitCode, stderr } = await runCmd([
      'config',
      'set',
      'apiKey',
      'sk-...',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('exits with code 2 for read-only key (email)', async () => {
    const { exitCode, stderr } = await runCmd([
      'config',
      'set',
      'email',
      'x@y.cz',
      '--output',
      'json',
    ]);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});
