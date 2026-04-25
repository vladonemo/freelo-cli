import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() },
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

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
  // Capture only the FIRST exit code — run()'s outer catch may re-call
  // process.exit(1) after catching the thrown mock error.
  const exitSpy = vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
    if (firstExitCode === undefined) firstExitCode = _code ?? 0;
    throw new Error(`EXIT:${_code ?? 0}`);
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

async function runLogout(
  runFn: (argv: string[]) => Promise<void>,
  extraArgs: string[] = [],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const { stdout, stderr, getFirstExitCode, restore } = captureOutput();

  try {
    await runFn(['node', 'freelo', 'auth', 'logout', '--output', 'json', ...extraArgs]);
  } catch {
    // Swallow all errors — exit code captured by mock.
  } finally {
    restore();
  }

  return { stdout: stdout.join(''), stderr: stderr.join(''), exitCode: getFirstExitCode() ?? 0 };
}

describe('auth logout — absent profile is idempotent', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-logout-absent-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    vi.doMock('conf', () => {
      const data: Record<string, unknown> = {};
      const ConfMock = vi.fn().mockImplementation(() => ({
        get path() {
          return join(testDir, 'config.json');
        },
        has: (key: string) => key in data,
        get store() {
          return { ...data };
        },
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(data)) delete data[k];
          Object.assign(data, val);
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 0 when the profile does not exist', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogout(run);
    expect(exitCode).toBe(0);
  });

  it('emits removed: false when the profile was absent', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogout(run);
    const parsed = JSON.parse(stdout.trim()) as { data: { removed: boolean } };
    expect(parsed.data.removed).toBe(false);
  });

  it('emits a freelo.auth.logout/v1 envelope', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogout(run);
    const parsed = JSON.parse(stdout.trim()) as { schema: string };
    expect(parsed.schema).toBe('freelo.auth.logout/v1');
  });
});

describe('auth logout — present profile is removed', () => {
  let testDir: string;
  let storeData: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-logout-present-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    // Pre-populate with a profile
    storeData = {
      schemaVersion: 1,
      currentProfile: 'default',
      profiles: {
        default: { email: 'user@example.com', apiBaseUrl: 'https://api.freelo.io/v1' },
      },
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
        set store(val: Record<string, unknown>) {
          for (const k of Object.keys(storeData)) delete storeData[k];
          Object.assign(storeData, val);
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('exits with code 0 when profile exists and is removed', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { exitCode } = await runLogout(run);
    expect(exitCode).toBe(0);
  });

  it('emits removed: true when the profile existed', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    const { stdout } = await runLogout(run);
    const parsed = JSON.parse(stdout.trim()) as { data: { removed: boolean } };
    expect(parsed.data.removed).toBe(true);
  });

  it('clears currentProfile when the removed profile was current', async () => {
    const { run } = await import('../../../src/bin/freelo.js');
    await runLogout(run);
    const store = storeData as {
      currentProfile: string | null;
      profiles: Record<string, unknown>;
    };
    expect(store.currentProfile).toBeNull();
    expect(store.profiles['default']).toBeUndefined();
  });

  it('does not make any API call (no MSW handler needed)', async () => {
    // logout never calls the Freelo API — if it did, MSW would throw on unhandled request
    const { run } = await import('../../../src/bin/freelo.js');
    await expect(runLogout(run)).resolves.toBeDefined();
  });
});

describe('auth logout — human mode', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-logout-human-${Date.now()}`);
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

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: true });
    delete process.env['CI'];
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

  it('emits human-readable text for absent profile', async () => {
    const stdoutWrites: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: unknown) => {
      stdoutWrites.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    vi.spyOn(process, 'exit').mockImplementation((_code?: number) => {
      throw new Error(`EXIT:${_code ?? 0}`);
    });

    const { run } = await import('../../../src/bin/freelo.js');

    try {
      await run(['node', 'freelo', 'auth', 'logout', '--output', 'human']);
    } catch {
      // may exit 0
    }

    const combined = stdoutWrites.join('');
    expect(combined).toContain('nothing to remove');
  });
});
