import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/config/tokens.ts — keytar facade with file fallback.
 * keytar is mocked via vi.mock to avoid native module loading.
 */

// We mock keytar at the module level so the tokens module can import it.
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

describe('tokens — keytar happy path', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-kt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.resetModules();

    // Reset keytar mock state
    delete process.env['FREELO_NO_KEYCHAIN'];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('reads a token via keytar when it is available', async () => {
    const keytar = await import('keytar');
    vi.mocked(keytar.getPassword).mockResolvedValue('sk-from-keytar');

    const { _resetKeytarState, readToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    const result = await readToken('default');
    expect(result).toBe('sk-from-keytar');
  });

  it('writes a token via keytar when it is available', async () => {
    const keytar = await import('keytar');
    vi.mocked(keytar.setPassword).mockResolvedValue(undefined);

    const { _resetKeytarState, writeToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    await writeToken('default', 'sk-new-key', { mode: 'json' });
    expect(keytar.setPassword).toHaveBeenCalledWith('freelo-cli', 'default', 'sk-new-key');
  });

  it('deletes a token via keytar', async () => {
    const keytar = await import('keytar');
    vi.mocked(keytar.deletePassword).mockResolvedValue(true);

    const { _resetKeytarState, deleteToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    await expect(deleteToken('default')).resolves.toBeUndefined();
  });
});

describe('tokens — FREELO_NO_KEYCHAIN=1 forces file fallback', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-nk-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.resetModules();
    process.env['FREELO_NO_KEYCHAIN'] = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('writes to fallback file when FREELO_NO_KEYCHAIN=1', async () => {
    const keytar = await import('keytar');
    const { _resetKeytarState, writeToken, readToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    await writeToken('ci', 'sk-ci-key', { mode: 'json' });
    // keytar.setPassword should NOT have been called
    expect(keytar.setPassword).not.toHaveBeenCalled();

    // Verify the token is readable from file fallback
    const result = await readToken('ci');
    expect(result).toBe('sk-ci-key');
  });

  it('reads from fallback file when FREELO_NO_KEYCHAIN=1', async () => {
    const { _resetKeytarState, writeToken, readToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    await writeToken('ci', 'sk-fallback', { mode: 'json' });
    const result = await readToken('ci');
    expect(result).toBe('sk-fallback');
  });
});

describe('tokens — missing token returns null', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-null-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.resetModules();
    process.env['FREELO_NO_KEYCHAIN'] = '1';
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('returns null when no token is stored in either keytar or the fallback file', async () => {
    const { _resetKeytarState, readToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();
    const result = await readToken('nonexistent-profile');
    expect(result).toBeNull();
  });
});

describe('tokens — delete attempts both stores', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-del-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    vi.resetModules();
    delete process.env['FREELO_NO_KEYCHAIN'];
    try {
      await rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('does not throw when deleting a profile that does not exist in either store', async () => {
    const keytar = await import('keytar');
    vi.mocked(keytar.deletePassword).mockResolvedValue(false);

    const { _resetKeytarState, deleteToken } = await import('../../src/config/tokens.js');
    _resetKeytarState();

    await expect(deleteToken('nonexistent')).resolves.toBeUndefined();
  });

  it('deletes from file fallback when FREELO_NO_KEYCHAIN=1 is set', async () => {
    process.env['FREELO_NO_KEYCHAIN'] = '1';
    vi.resetModules();

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

    const { _resetKeytarState, writeToken, deleteToken, readToken } = await import(
      '../../src/config/tokens.js'
    );
    _resetKeytarState();

    // Write a token to the fallback file
    await writeToken('deleteme', 'sk-to-delete', { mode: 'json' });

    // Confirm it exists
    const before = await readToken('deleteme');
    expect(before).toBe('sk-to-delete');

    // Delete it
    await deleteToken('deleteme');

    // Confirm it's gone
    const after = await readToken('deleteme');
    expect(after).toBeNull();
  });
});
