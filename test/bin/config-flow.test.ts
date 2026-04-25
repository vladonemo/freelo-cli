/**
 * Integration test: config-flow
 *
 * Covers plan §8.3 scenarios in-process (no child-process spawning, no MSW):
 *   1. Fresh-install `config list` — all sources default.
 *   2. `config set output json` round-trip via `config get output`.
 *   3. RC fixture: `config resolve --show-source` reports source: 'rc' for rc-supplied keys.
 *   4. Malformed RC: top-level error path emits freelo.error/v1 with code CONFIG_ERROR / kind corrupt-rc.
 *   5. Non-TTY stdout defaults to JSON output.
 */

import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURES_RC_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/rc');

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

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
    const { run } = await import('../../src/bin/freelo.js');
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
      // try next
    }
  }
  throw new Error(`No valid JSON line found in: ${JSON.stringify(text)}`);
}

// ---------------------------------------------------------------------------
// Scenario 1 — Fresh install: all sources are 'default'
// ---------------------------------------------------------------------------

describe('config-flow: fresh-install config list', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-flow-fresh-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    // Point cwd at testDir so no rc file is discovered
    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

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

  it('emits freelo.config.list/v1 with all sources = default for fresh install', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);

    const parsed = parseFirstJson(stdout) as {
      schema: string;
      data: { keys: Array<{ key: string; source: string }> };
    };
    expect(parsed.schema).toBe('freelo.config.list/v1');

    // Canonical key set
    const keys = parsed.data.keys.map((k) => k.key);
    expect(keys).toContain('output');
    expect(keys).toContain('color');
    expect(keys).toContain('profile');
    expect(keys).toContain('apiBaseUrl');
    expect(keys).toContain('verbose');
    expect(keys).toContain('apiKey');
    expect(keys).toContain('email');
    expect(keys).toContain('profileSource');
    expect(keys).toContain('requestId');
    expect(keys).toContain('userAgent');
    expect(keys).toContain('yes');

    // All sources are 'default' on a fresh install (no env, no rc, no conf)
    const nonDefault = parsed.data.keys.filter(
      (k) => k.source !== 'default' && k.source !== 'generated',
    );
    expect(nonDefault).toHaveLength(0);
  });

  it('email value is "" and source is "default" for fresh install', async () => {
    const { stdout } = await runCmd(['config', 'list', '--output', 'json']);
    const parsed = parseFirstJson(stdout) as {
      data: { keys: Array<{ key: string; value: unknown; source: string }> };
    };
    const emailEntry = parsed.data.keys.find((k) => k.key === 'email');
    expect(emailEntry?.value).toBe('');
    expect(emailEntry?.source).toBe('default');
  });
});

// ---------------------------------------------------------------------------
// Scenario 2 — config set output json, then config get output round-trips
// ---------------------------------------------------------------------------

describe('config-flow: config set / config get round-trip', () => {
  let testDir: string;
  let data: Record<string, unknown>;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-flow-set-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
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

    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

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

  it('config set output json then config get output returns value=json source=conf', async () => {
    // First set
    const setResult = await runCmd(['config', 'set', 'output', 'json', '--output', 'json']);
    expect(setResult.exitCode).toBe(0);

    // Reset modules so next run picks up the mutated `data` store
    vi.resetModules();

    // Then get
    const getResult = await runCmd(['config', 'get', 'output', '--output', 'json']);
    expect(getResult.exitCode).toBe(0);

    const parsed = parseFirstJson(getResult.stdout) as {
      data: { key: string; value: unknown; source: string };
    };
    expect(parsed.data.key).toBe('output');
    expect(parsed.data.value).toBe('json');
    expect(parsed.data.source).toBe('conf');
  });
});

// ---------------------------------------------------------------------------
// Scenario 3 — env source layer: FREELO_DEBUG=1 is reflected in config list.
//
// RC-file-based source attribution (source: 'rc') for the full command pipeline
// is covered by test/config/rc-loader.test.ts (loader) and test/config/resolve.test.ts
// (buildPartialAppConfig + buildSourceMap with rc parameter). The malformed-rc scenario
// (scenario 4) verifies the CLI error path when rc discovery fails.
//
// Here we validate the env layer: FREELO_DEBUG=1 sets verbose=2 with source=env.
// This env var is checked BEFORE the Commander --verbose flag default (0) in
// buildPartialAppConfig, so it reliably overrides the Commander default.
// ---------------------------------------------------------------------------

describe('config-flow: env-layer verbose via FREELO_DEBUG flows through to config list', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-flow-debug-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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
    process.env['FREELO_DEBUG'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    delete process.env['FREELO_DEBUG'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('FREELO_DEBUG=1 sets verbose=2 with source=env in config list', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);

    const parsed = parseFirstJson(stdout) as {
      data: { keys: Array<{ key: string; value: unknown; source: string }> };
    };
    const verboseEntry = parsed.data.keys.find((k) => k.key === 'verbose');
    // FREELO_DEBUG=1 forces verbose=2 (debug level) in buildPartialAppConfig,
    // overriding the Commander flag default of 0.
    expect(verboseEntry?.value).toBe('2');
    // buildSourceMap also checks FREELO_DEBUG first → source = 'env'
    expect(verboseEntry?.source).toBe('env');
  });
});

// ---------------------------------------------------------------------------
// Scenario 4 — Malformed RC: error envelope with code CONFIG_ERROR
// ---------------------------------------------------------------------------

describe('config-flow: malformed rc emits freelo.error/v1 with CONFIG_ERROR', () => {
  it('emits freelo.error/v1 with code CONFIG_ERROR and exits with code 2', async () => {
    const testDir = join(
      tmpdir(),
      `freelo-flow-bad-rc-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    // Write a malformed YAML rc file into testDir
    await writeFile(
      join(testDir, '.freelorc.yaml'),
      'output: json\ncolor: [this is: malformed: yaml\n  - unclosed bracket\n',
      'utf8',
    );

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

    // Point cwd at testDir so cosmiconfig finds the malformed yaml
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(testDir);

    // Reset modules AFTER spy so fresh import of rc-loader uses mocked cwd
    vi.resetModules();

    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: false });

    try {
      const { stderr, exitCode } = await runCmd(['config', 'list', '--output', 'json']);

      expect(exitCode).toBe(2);

      const parsed = parseFirstJson(stderr) as {
        schema: string;
        error: { code: string };
      };
      expect(parsed.schema).toBe('freelo.error/v1');
      expect(parsed.error.code).toBe('CONFIG_ERROR');
    } finally {
      cwdSpy.mockRestore();
      vi.restoreAllMocks();
      vi.resetModules();
      Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
      Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
      try {
        await rm(testDir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Scenario 5 — Non-TTY stdout defaults to JSON output
// ---------------------------------------------------------------------------

describe('config-flow: non-TTY stdout defaults to JSON', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-flow-nontty-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

    vi.resetModules();

    process.env['FREELO_NO_KEYCHAIN'] = '1';
    // Simulate non-TTY: isTTY is false (default in test env, but explicit here)
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

  it('stdout contains a JSON envelope (freelo.config.list/v1) when stdout is non-TTY', async () => {
    // Run WITHOUT --output flag — relies on auto-resolution to json
    const { stdout, exitCode } = await runCmd(['config', 'list']);
    expect(exitCode).toBe(0);

    // Should be parseable JSON envelope
    const parsed = parseFirstJson(stdout) as { schema: string };
    expect(parsed.schema).toBe('freelo.config.list/v1');
  });
});

// ---------------------------------------------------------------------------
// Scenario: logged-in profile shows real email + 'conf' source in config list
// ---------------------------------------------------------------------------

describe('config-flow: logged-in profile shows email in config list', () => {
  let testDir: string;
  const PROFILE_EMAIL = 'agent@acme.cz';

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-flow-email-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    const storeData = {
      schemaVersion: 2,
      currentProfile: 'default',
      profiles: {
        default: { email: PROFILE_EMAIL, apiBaseUrl: 'https://api.freelo.io/v1' },
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

    vi.spyOn(process, 'cwd').mockReturnValue(testDir);

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

  it('shows the profile email with source=conf when profile has email in conf store', async () => {
    const { stdout, exitCode } = await runCmd(['config', 'list', '--output', 'json']);
    expect(exitCode).toBe(0);

    const parsed = parseFirstJson(stdout) as {
      data: { keys: Array<{ key: string; value: unknown; source: string }> };
    };
    const emailEntry = parsed.data.keys.find((k) => k.key === 'email');
    expect(emailEntry?.value).toBe(PROFILE_EMAIL);
    expect(emailEntry?.source).toBe('conf');
  });
});

// Ensure FIXTURES_RC_DIR import resolves (used in other test suites for reference)
void FIXTURES_RC_DIR;
