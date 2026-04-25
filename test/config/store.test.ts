import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for the config store (Conf-backed).
 * Each test uses a unique temp directory via Conf's cwd option by
 * resetting the module-level _confInstance between tests.
 */

describe('config/store — round-trip', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-store-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    // Point Conf at our temp dir by mocking the Conf constructor
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => {
        const data: Record<string, unknown> = {};
        return {
          get path() {
            return join(testDir, 'config.json');
          },
          has: (key: string) => key in data,
          get store() {
            return { ...data };
          },
          set store(val: Record<string, unknown>) {
            for (const key of Object.keys(data)) {
              delete data[key];
            }
            Object.assign(data, val);
          },
        };
      });
      return { default: ConfMock };
    });

    // Reset module to pick up the mock
    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  it('returns default store on first read when no config exists', async () => {
    const { readStore } = await import('../../src/config/store.js');
    const store = readStore();
    expect(store.schemaVersion).toBe(1);
    expect(store.currentProfile).toBeNull();
    expect(store.profiles).toEqual({});
  });

  it('writes and reads back a profile round-trip', async () => {
    const { writeProfile, readStore } = await import('../../src/config/store.js');
    writeProfile('myprofile', {
      email: 'user@example.com',
      apiBaseUrl: 'https://api.freelo.io/v1',
    });
    const store = readStore();
    expect(store.profiles['myprofile']).toEqual({
      email: 'user@example.com',
      apiBaseUrl: 'https://api.freelo.io/v1',
    });
  });

  it('removes a profile and clears currentProfile when it matches', async () => {
    const { writeProfile, writeStore, removeProfile, readStore } = await import(
      '../../src/config/store.js'
    );
    writeProfile('p1', { email: 'a@b.com', apiBaseUrl: 'https://api.freelo.io/v1' });
    // Set currentProfile to p1
    const store = readStore();
    writeStore({ ...store, currentProfile: 'p1' });

    removeProfile('p1');
    const updated = readStore();
    expect(updated.profiles['p1']).toBeUndefined();
    expect(updated.currentProfile).toBeNull();
  });

  it('does nothing when removing a profile that does not exist', async () => {
    const { removeProfile, readStore } = await import('../../src/config/store.js');
    // Should not throw
    expect(() => removeProfile('nonexistent')).not.toThrow();
    const store = readStore();
    expect(store.profiles).toEqual({});
  });

  it('setCurrentProfile updates the currentProfile field', async () => {
    const { writeProfile, setCurrentProfile, readStore } = await import(
      '../../src/config/store.js'
    );
    writeProfile('prod', { email: 'x@y.com', apiBaseUrl: 'https://api.freelo.io/v1' });
    setCurrentProfile('prod');
    expect(readStore().currentProfile).toBe('prod');
  });

  it('setCurrentProfile with null clears currentProfile', async () => {
    const { setCurrentProfile, readStore } = await import('../../src/config/store.js');
    setCurrentProfile(null);
    expect(readStore().currentProfile).toBeNull();
  });
});

describe('config/store — corrupt config', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-store-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });

    // Mock Conf to return corrupt data
    vi.doMock('conf', () => {
      const ConfMock = vi.fn().mockImplementation(() => {
        const corruptData = { schemaVersion: 99, unexpected: true }; // fails .strict() schema
        return {
          get path() {
            return join(testDir, 'config.json');
          },
          has: (_key: string) => true, // pretend key exists
          get store() {
            return corruptData;
          },
          set store(_val: Record<string, unknown>) {
            // no-op
          },
        };
      });
      return { default: ConfMock };
    });

    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('throws ConfigError with kind corrupt-config when the store fails zod validation', async () => {
    const { readStore } = await import('../../src/config/store.js');
    const { ConfigError } = await import('../../src/errors/config-error.js');

    expect(() => readStore()).toThrow(ConfigError);
    try {
      readStore();
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      expect((err as import('../../src/errors/config-error.js').ConfigError).kind.kind).toBe(
        'corrupt-config',
      );
    }
  });
});

describe('config/store — tokens file', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `freelo-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}`);
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
        set store(_v: unknown) {
          // no-op
        },
      }));
      return { default: ConfMock };
    });

    vi.resetModules();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('readTokensFile returns empty object when tokens.json does not exist', async () => {
    const { readTokensFile } = await import('../../src/config/store.js');
    const tokens = await readTokensFile();
    expect(tokens).toEqual({});
  });

  it('writeTokensFile + readTokensFile round-trip', async () => {
    const { readTokensFile, writeTokensFile } = await import('../../src/config/store.js');
    await writeTokensFile({ myprofile: 'sk-abc123' });
    const tokens = await readTokensFile();
    expect(tokens['myprofile']).toBe('sk-abc123');
  });
});
