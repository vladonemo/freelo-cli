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

describe('config unset — existing key', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-unset-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await mkdir(testDir, { recursive: true });
    // Pre-populate with an output default
    data = {
      schemaVersion: 2,
      currentProfile: null,
      profiles: {},
      defaults: { output: 'json' },
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

  it('unsets existing default key with removed: true', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'unset', 'output', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { key: string; removed: boolean; previous_value: string; scope: string };
    };
    expect(parsed.schema).toBe('freelo.config.unset/v1');
    expect(parsed.data.key).toBe('output');
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.previous_value).toBe('json');
    expect(parsed.data.scope).toBe('defaults');
    expect(exitCode).toBe(0);
  });
});

describe('config unset — already-unset key (idempotent)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-unset-idem-${Date.now()}`);
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

  it('unset on already-unset key: removed: false, exit 0', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'unset', 'color', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { removed: boolean; previous_value: unknown };
    };
    expect(parsed.data.removed).toBe(false);
    expect(parsed.data.previous_value).toBeNull();
    expect(exitCode).toBe(0);
  });
});

describe('config unset — errors', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-unset-err-${Date.now()}`);
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

  it('exits with code 2 for read-only key (apiKey)', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'unset', 'apiKey', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('exits with code 2 for read-only key (email)', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'unset', 'email', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });

  it('exits with code 2 for unknown key', async () => {
    const { exitCode, stderr } = await runCmd(['config', 'unset', 'fooBar', '--output', 'json']);
    expect(exitCode).toBe(2);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('VALIDATION_ERROR');
  });
});

// Pre-populated `verbose: 2` default → exercises the verbose number→string coerce
// branch (src/commands/config/unset.ts:79-82).
describe('config unset — verbose default coercion', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-unset-verbose-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    data = {
      schemaVersion: 2,
      currentProfile: null,
      profiles: {},
      defaults: { verbose: 2 },
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

  it('previous_value is the string "2" (coerced) when unsetting verbose=2', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'unset', 'verbose', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { key: string; removed: boolean; previous_value: unknown; scope: string };
    };
    expect(parsed.data.key).toBe('verbose');
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.previous_value).toBe('2');
    expect(parsed.data.scope).toBe('defaults');
    expect(exitCode).toBe(0);
  });
});

// scope === 'currentProfile' branches: unset profile when set, and idempotent
// when already null (src/commands/config/unset.ts:87-92).
describe('config unset — profile (currentProfile scope)', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  async function setup(currentProfile: string | null) {
    testDir = join(
      tmpdir(),
      `freelo-unset-profile-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    data = {
      schemaVersion: 2,
      currentProfile,
      profiles: { default: { email: 'a@b.cz', apiBaseUrl: 'https://api.freelo.io/v1' } },
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
  }

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    if (testDir) {
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('unset profile when set: removed: true, previous_value reflects the prior name', async () => {
    await setup('staging');
    const { stdout, exitCode } = await runCmd(['config', 'unset', 'profile', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { key: string; removed: boolean; previous_value: unknown; scope: string };
    };
    expect(parsed.data.key).toBe('profile');
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.previous_value).toBe('staging');
    expect(parsed.data.scope).toBe('defaults');
    expect(exitCode).toBe(0);
  });

  it('unset profile when already null: removed: false, previous_value: null (idempotent)', async () => {
    await setup(null);
    const { stdout, exitCode } = await runCmd(['config', 'unset', 'profile', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { key: string; removed: boolean; previous_value: unknown };
    };
    expect(parsed.data.key).toBe('profile');
    expect(parsed.data.removed).toBe(false);
    expect(parsed.data.previous_value).toBeNull();
    expect(exitCode).toBe(0);
  });
});

// scope === 'profile' branches: unset apiBaseUrl resets to default; missing
// profile errors with ConfigError (src/commands/config/unset.ts:94-110).
describe('config unset — apiBaseUrl (profile scope)', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  async function setupShared(initialData: Record<string, unknown>) {
    testDir = join(
      tmpdir(),
      `freelo-unset-aburl-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    data = initialData;
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
  }

  beforeEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    if (testDir) {
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });

  it('unset apiBaseUrl resets active profile URL to the default; removed: true', async () => {
    await setupShared({
      schemaVersion: 2,
      currentProfile: 'default',
      profiles: { default: { email: 'a@b.cz', apiBaseUrl: 'https://custom.example.cz/v1' } },
      defaults: {},
    });
    const { stdout, exitCode } = await runCmd([
      'config',
      'unset',
      'apiBaseUrl',
      '--output',
      'json',
    ]);
    const parsed = parseFirstJson(stdout) as {
      data: {
        key: string;
        removed: boolean;
        previous_value: unknown;
        scope: string;
        profile: string | null;
      };
    };
    expect(parsed.data.key).toBe('apiBaseUrl');
    expect(parsed.data.removed).toBe(true);
    expect(parsed.data.previous_value).toBe('https://custom.example.cz/v1');
    expect(parsed.data.scope).toBe('profile');
    expect(parsed.data.profile).toBe('default');
    expect(exitCode).toBe(0);
  });

  it('unset apiBaseUrl with no active profile errors as missing-profile', async () => {
    await setupShared({
      schemaVersion: 2,
      currentProfile: null,
      profiles: {},
      defaults: {},
    });
    const { stderr, exitCode } = await runCmd([
      'config',
      'unset',
      'apiBaseUrl',
      '--output',
      'json',
    ]);
    // missing-profile ConfigError → AUTH_MISSING with exit 3.
    expect(exitCode).toBe(3);
    const parsed = parseFirstJson(stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe('AUTH_MISSING');
  });
});
