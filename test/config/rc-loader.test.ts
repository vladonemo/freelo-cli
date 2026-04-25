import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FIXTURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '../fixtures/rc');

/**
 * Helper: reset module cache, then load rc-loader fresh pointing at `fixtureDir`.
 */
async function freshLoader() {
  vi.resetModules();
  return import('../../src/config/rc-loader.js');
}

/**
 * Helper that determines if an error is a ConfigError (kind: corrupt-rc)
 * without relying on instanceof across module reloads.
 */
function isCorruptRcError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as Record<string, unknown>;
  return (
    e['code'] === 'CONFIG_ERROR' &&
    typeof e['kind'] === 'object' &&
    e['kind'] !== null &&
    (e['kind'] as Record<string, unknown>)['kind'] === 'corrupt-rc' &&
    e['exitCode'] === 2
  );
}

describe('rc-loader — valid fixtures', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('returns null when no rc file exists in the cwd tree', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    // '/' (root) should have no .freelorc file
    const result = loadRcSync('/');
    expect(result).toBeNull();
  });

  it('parses .freelorc.json correctly', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    const result = loadRcSync(join(FIXTURES_DIR, 'valid-json'));
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({ output: 'json', color: 'never', profile: 'ci' });
    expect(result!.filepath).toContain('.freelorc.json');
  });

  it('parses .freelorc.yaml correctly', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    const result = loadRcSync(join(FIXTURES_DIR, 'valid-yaml'));
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({ output: 'ndjson', verbose: 1 });
    expect(result!.filepath).toContain('.freelorc.yaml');
  });

  it('parses extension-less .freelorc (JSON content)', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    const result = loadRcSync(join(FIXTURES_DIR, 'valid-noext'));
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({ output: 'human', verbose: 0 });
  });

  it('accepts empty {} as a valid no-op rc', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    const result = loadRcSync(join(FIXTURES_DIR, 'empty'));
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({});
  });

  it('does NOT load freelo.config.js — only the .freelorc.json is loaded', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    // The fixture directory has both a .freelorc.json and a freelo.config.js
    // that throws. If the JS file were loaded, the test would fail with an error.
    const result = loadRcSync(join(FIXTURES_DIR, 'js-not-loaded'));
    expect(result).not.toBeNull();
    expect(result!.config).toEqual({ output: 'json' });
  });
});

describe('rc-loader — invalid fixtures', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.resetModules();
  });

  it('throws a corrupt-rc error when rc has an unknown key (apiKey)', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    expect(() => loadRcSync(join(FIXTURES_DIR, 'invalid-unknown-key'))).toThrow();
    try {
      loadRcSync(join(FIXTURES_DIR, 'invalid-unknown-key'));
    } catch (err) {
      expect(isCorruptRcError(err)).toBe(true);
    }
  });

  it('throws a corrupt-rc error for malformed YAML', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    expect(() => loadRcSync(join(FIXTURES_DIR, 'invalid-yaml'))).toThrow();
    try {
      loadRcSync(join(FIXTURES_DIR, 'invalid-yaml'));
    } catch (err) {
      expect(isCorruptRcError(err)).toBe(true);
    }
  });

  it('throws a corrupt-rc error for Shape B (profiles: key) — strict schema rejects it', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    expect(() => loadRcSync(join(FIXTURES_DIR, 'shape-b-rejected'))).toThrow();
    try {
      loadRcSync(join(FIXTURES_DIR, 'shape-b-rejected'));
    } catch (err) {
      expect(isCorruptRcError(err)).toBe(true);
    }
  });
});

describe('rc-loader — hintNext content', () => {
  afterEach(() => {
    vi.resetModules();
  });

  it('includes the file path in ConfigError hintNext', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    try {
      loadRcSync(join(FIXTURES_DIR, 'invalid-unknown-key'));
    } catch (err) {
      expect(isCorruptRcError(err)).toBe(true);
      const e = err as { hintNext?: string };
      expect(e.hintNext).toContain('.freelorc');
    }
  });

  it('exitCode is 2 for corrupt-rc (user-correctable)', async () => {
    const { loadRcSync, _resetRcCache } = await freshLoader();
    _resetRcCache();
    try {
      loadRcSync(join(FIXTURES_DIR, 'invalid-unknown-key'));
    } catch (err) {
      const e = err as { exitCode?: number };
      expect(e.exitCode).toBe(2);
    }
  });
});
