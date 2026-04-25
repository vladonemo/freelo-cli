import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
}));

const API_BASE = 'https://api.freelo.io/v1';

/**
 * Helper: set up a Conf mock pointing at testDir and reset modules.
 */
function setupConfMock(testDir: string): void {
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
    process.env['FREELO_NO_KEYCHAIN'] = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses stdin key over env vars when stdinApiKey is provided', async () => {
    process.env['FREELO_API_KEY'] = 'sk-env-key';
    process.env['FREELO_EMAIL'] = 'env@example.com';

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      stdinApiKey: 'sk-stdin-key',
      emailFlag: 'stdin@example.com',
    });

    expect(result.apiKey).toBe('sk-stdin-key');
    expect(result.email).toBe('stdin@example.com');
    expect(result.source).toBe('stdin');
  });
});

describe('resolveCredentials — env takes precedence over keytar', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-env-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses env vars when both FREELO_API_KEY and FREELO_EMAIL are set', async () => {
    process.env['FREELO_API_KEY'] = 'sk-env-key';
    process.env['FREELO_EMAIL'] = 'env@example.com';

    const keytar = await import('keytar');
    vi.mocked(keytar.getPassword).mockResolvedValue('sk-keytar-key');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
    });

    expect(result.apiKey).toBe('sk-env-key');
    expect(result.email).toBe('env@example.com');
    expect(result.source).toBe('env');
    // keytar.getPassword should NOT be called when env is present
    expect(keytar.getPassword).not.toHaveBeenCalled();
  });

  it('uses emailFlag over FREELO_EMAIL when both are set and they match', async () => {
    process.env['FREELO_API_KEY'] = 'sk-env-key';
    process.env['FREELO_EMAIL'] = 'env@example.com';

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
      emailFlag: 'env@example.com',
    });

    expect(result.email).toBe('env@example.com');
  });
});

describe('resolveCredentials — keytar over conf-fallback', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-kt-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('uses keytar token when env is absent', async () => {
    const keytar = await import('keytar');
    vi.mocked(keytar.getPassword).mockResolvedValue('sk-keytar-token');

    const { resolveCredentials } = await import('../../src/config/credentials.js');
    const result = await resolveCredentials({
      profile: 'default',
      apiBaseUrl: API_BASE,
    });

    expect(result.apiKey).toBe('sk-keytar-token');
    expect(result.source).toBe('keytar');
  });
});

describe('resolveCredentials — missing credentials throws ConfigError', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-creds-miss-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    setupConfMock(testDir);
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    process.env['FREELO_NO_KEYCHAIN'] = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_API_KEY'];
    delete process.env['FREELO_EMAIL'];
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  it('throws ConfigError with kind missing-token when no credential source is available', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    // Import ConfigError from the same module registry (post-resetModules)
    const { ConfigError: CE } = await import('../../src/errors/config-error.js');
    await expect(resolveCredentials({ profile: 'default', apiBaseUrl: API_BASE })).rejects.toThrow(
      CE,
    );
  });

  it('throws ConfigError with missing-token kind', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    try {
      await resolveCredentials({ profile: 'default', apiBaseUrl: API_BASE });
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as { kind?: { kind: string } }).kind?.kind).toBe('missing-token');
    }
  });

  it('ConfigError has exitCode 3', async () => {
    const { resolveCredentials } = await import('../../src/config/credentials.js');
    try {
      await resolveCredentials({ profile: 'myprofile', apiBaseUrl: API_BASE });
    } catch (err) {
      expect((err as { exitCode?: number }).exitCode).toBe(3);
    }
  });
});
