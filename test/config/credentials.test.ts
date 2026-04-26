import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const API_BASE = 'https://api.freelo.io/v1';

/**
 * Helper: set up a Conf mock pointing at testDir and reset modules.
 *
 * `data` is the in-memory store backing the Conf mock; tests can pre-seed
 * it to simulate an existing profile.
 */
function setupConfMock(testDir: string, seed: Record<string, unknown> = {}): void {
  const data: Record<string, unknown> = { ...seed };
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
        for (const key of Object.keys(data)) delete data[key];
        Object.assign(data, val);
      },
    }));
    return { default: ConfMock };
  });
  vi.resetModules();
}

describe('resolveCredentials — stdin takes highest precedence', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-stdin-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses stdin key over env vars when stdinApiKey is provided', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: { FREELO_API_KEY: 'sk-env-key', FREELO_EMAIL: 'env@example.com' },
      stdinApiKey: 'sk-stdin-key',
      emailFlag: 'stdin@example.com',
    });

    expect(result.apiKey).toBe('sk-stdin-key');
    expect(result.email).toBe('stdin@example.com');
    expect(result.source).toBe('stdin');
  });
});

describe('resolveCredentials — env beats tokens.json', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-env-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses env vars when both FREELO_API_KEY and FREELO_EMAIL are set', async () => {
    // Pre-seed a token in tokens.json — env must still win.
    const { writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-from-file');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: { FREELO_API_KEY: 'sk-env-key', FREELO_EMAIL: 'env@example.com' },
    });

    expect(result.apiKey).toBe('sk-env-key');
    expect(result.email).toBe('env@example.com');
    expect(result.source).toBe('env');
  });

  it('uses emailFlag over FREELO_EMAIL when both are set and they match', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: { FREELO_API_KEY: 'sk-env-key', FREELO_EMAIL: 'env@example.com' },
      emailFlag: 'env@example.com',
    });

    expect(result.email).toBe('env@example.com');
  });

  it('falls through when only FREELO_API_KEY is set without FREELO_EMAIL', async () => {
    // Seed a tokens.json so the fallback succeeds.
    const { writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-from-file');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: { FREELO_API_KEY: 'sk-env-key' }, // no FREELO_EMAIL
    });

    expect(result.source).toBe('conf-fallback');
    expect(result.apiKey).toBe('sk-from-file');
  });
});

describe('resolveCredentials — tokens.json fallback', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-file-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses tokens.json token when env is absent', async () => {
    const { writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-from-file');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: {},
    });

    expect(result.apiKey).toBe('sk-from-file');
    expect(result.source).toBe('conf-fallback');
  });

  it('returns the email from the conf store when tokens.json is the source', async () => {
    const seed = {
      schemaVersion: 2,
      currentProfile: 'default',
      profiles: {
        default: { email: 'stored@example.com', apiBaseUrl: API_BASE },
      },
      defaults: {},
    };
    setupConfMock(testDir, seed);

    const { writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-from-file');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      env: {},
    });

    expect(result.source).toBe('conf-fallback');
    expect(result.email).toBe('stored@example.com');
  });
});

describe('resolveCredentials — missing credentials throws ConfigError', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-miss-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('throws ConfigError with kind missing-token when no credential source is available', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const { ConfigError: CE } = await import('../../src/errors/config-error.js');
    await expect(
      resolveCredentials({ profile: 'default', apiBaseUrl: API_BASE, env: {} }),
    ).rejects.toThrow(CE);
  });

  it('throws ConfigError with missing-token kind', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    try {
      await resolveCredentials({ profile: 'default', apiBaseUrl: API_BASE, env: {} });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { kind?: { kind: string } }).kind?.kind).toBe('missing-token');
    }
  });

  it('ConfigError has exitCode 3', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    try {
      await resolveCredentials({ profile: 'myprofile', apiBaseUrl: API_BASE, env: {} });
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});
