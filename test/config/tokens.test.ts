import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdir, rm, readFile, stat, writeFile } from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Tests for src/config/tokens.ts — file-only token store.
 *
 * After the keytar removal, `tokens.json` (mode 0600, in `getConfDir()`) is
 * the sole persistent token store. These tests cover the round-trip,
 * idempotent delete, missing-file behavior, and the 0600 mode bit on POSIX.
 */

function withConfMock(testDir: string): void {
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
}

describe('tokens — read/write round-trip', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-rt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    withConfMock(testDir);
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

  it('returns null when no tokens.json exists yet', async () => {
    const { readToken } = await import('../../src/config/tokens.js');
    const result = await readToken('default');
    expect(result).toBeNull();
  });

  it('writes a token and reads it back', async () => {
    const { readToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-fresh');
    const result = await readToken('default');
    expect(result).toBe('sk-fresh');
  });

  it('persists multiple profiles independently', async () => {
    const { readToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-default');
    await writeToken('ci', 'sk-ci');
    expect(await readToken('default')).toBe('sk-default');
    expect(await readToken('ci')).toBe('sk-ci');
  });

  it('overwrites the existing entry on second write', async () => {
    const { readToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-old');
    await writeToken('default', 'sk-new');
    expect(await readToken('default')).toBe('sk-new');
  });

  it('returns null for a missing profile when other profiles are stored', async () => {
    const { readToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('ci', 'sk-ci');
    expect(await readToken('default')).toBeNull();
  });
});

describe('tokens — file mode is 0600 (POSIX only)', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-mode-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    withConfMock(testDir);
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

  it.skipIf(process.platform === 'win32')('creates tokens.json with mode 0600', async () => {
    const { writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-secret');
    const tokensPath = join(testDir, 'tokens.json');
    const fileStat = await stat(tokensPath);
    // Mask off the file-type bits; only permission bits remain.
    const perms = fileStat.mode & 0o777;
    expect(perms).toBe(0o600);
  });
});

describe('tokens — delete is idempotent', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-del-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    withConfMock(testDir);
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

  it('does not throw when deleting from a non-existent file', async () => {
    const { deleteToken } = await import('../../src/config/tokens.js');
    await expect(deleteToken('nonexistent')).resolves.toBeUndefined();
  });

  it('does not throw when deleting an absent profile from an existing file', async () => {
    const { deleteToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('ci', 'sk-ci');
    await expect(deleteToken('default')).resolves.toBeUndefined();
  });

  it('removes a present entry and leaves siblings intact', async () => {
    const { deleteToken, readToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-default');
    await writeToken('ci', 'sk-ci');

    await deleteToken('default');

    expect(await readToken('default')).toBeNull();
    expect(await readToken('ci')).toBe('sk-ci');
  });

  it('writes back an empty map when the only entry is removed', async () => {
    const { deleteToken, writeToken } = await import('../../src/config/tokens.js');
    await writeToken('default', 'sk-default');
    await deleteToken('default');

    const tokensPath = join(testDir, 'tokens.json');
    const raw = await readFile(tokensPath, 'utf8');
    expect(JSON.parse(raw)).toEqual({});
  });
});

describe('tokens — corrupt tokens.json is treated as empty', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = join(
      tmpdir(),
      `freelo-tokens-corrupt-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    await mkdir(testDir, { recursive: true });
    withConfMock(testDir);
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

  it('returns null on read when tokens.json is malformed', async () => {
    // Pre-seed a malformed tokens.json
    const tokensPath = join(testDir, 'tokens.json');
    await writeFile(tokensPath, '{not-json', 'utf8');

    const { readToken } = await import('../../src/config/tokens.js');
    const result = await readToken('default');
    expect(result).toBeNull();
  });
});
