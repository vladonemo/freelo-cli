import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Conf from 'conf';
import { type ConfStore, type Defaults, ConfStoreSchema } from './schema.js';
import { ConfigError } from '../errors/config-error.js';

/**
 * Default store contents for a fresh install (schema version 2).
 */
const DEFAULT_STORE: ConfStore = {
  schemaVersion: 2,
  currentProfile: null,
  profiles: {},
  defaults: {},
};

type ConfInstance = InstanceType<typeof Conf>;

let _confInstance: ConfInstance | undefined;

/**
 * Return a `Conf` instance for the freelo-cli project. Lazily initialized;
 * the same instance is returned on subsequent calls within a process.
 *
 * The `conf` instance owns file-system path selection (platform-correct
 * XDG / Library / AppData paths).
 */
function getConf(): ConfInstance {
  if (_confInstance) return _confInstance;
  _confInstance = new Conf({ projectName: 'freelo-cli' });
  return _confInstance;
}

/** Exported for tests to reset module state. */
export function _resetConfInstance(): void {
  _confInstance = undefined;
}

/**
 * Return the directory that holds the conf file. Useful for resolving sibling
 * files (e.g. `tokens.json`).
 */
export function getConfDir(): string {
  return join(getConf().path, '..');
}

/**
 * Migrate a v1 store to v2 by adding the `defaults: {}` field and bumping
 * `schemaVersion` to 2.
 *
 * Migration is read-only-on-read — the result is NOT written back to disk
 * here. The migrated shape will be persisted the next time `writeStore` is
 * called organically (e.g. on `config set`, `auth login`).
 */
export function migrateV1toV2(raw: unknown): unknown {
  if (
    typeof raw === 'object' &&
    raw !== null &&
    (raw as { schemaVersion?: unknown }).schemaVersion === 1
  ) {
    return { ...raw, schemaVersion: 2, defaults: {} };
  }
  return raw;
}

/**
 * Read and validate the full store. Returns `DEFAULT_STORE` when the conf file
 * does not exist yet (fresh install).
 *
 * Runs `migrateV1toV2` on the raw object before zod-parsing so v1 stores
 * are transparently handled without writing back.
 *
 * Throws `ConfigError({ kind: 'corrupt-config' })` when the file exists but
 * fails the zod schema after migration.
 */
export function readStore(): ConfStore {
  const conf = getConf();

  // Conf stores a flat key→value map; our store is nested under a single
  // 'store' key for atomic reads. On first run the key doesn't exist.
  if (!conf.has('schemaVersion')) {
    return { ...DEFAULT_STORE };
  }

  // Read the raw object from conf (all keys at top level).
  const raw = conf.store;

  // Apply v1→v2 migration (no-op on v2+).
  const migrated = migrateV1toV2(raw);

  const result = ConfStoreSchema.safeParse(migrated);
  if (!result.success) {
    throw new ConfigError(
      `Config file is corrupt or has an unexpected format. Zod errors: ${result.error.message}`,
      { kind: 'corrupt-config', path: conf.path },
    );
  }
  return result.data;
}

/**
 * Persist the full store object, overwriting any existing content.
 */
export function writeStore(data: ConfStore): void {
  const conf = getConf();
  // Replace all keys atomically via conf.store setter.
  conf.store = data as unknown as Record<string, unknown>;
}

/**
 * Write (or overwrite) a profile entry. Does not set `currentProfile`.
 */
export function writeProfile(name: string, profile: { email: string; apiBaseUrl: string }): void {
  const store = readStore();
  const updated: ConfStore = {
    ...store,
    profiles: { ...store.profiles, [name]: profile },
  };
  writeStore(updated);
}

/**
 * Remove a profile. Also clears `currentProfile` when it matches `name`.
 * Idempotent — does nothing if the profile does not exist.
 */
export function removeProfile(name: string): void {
  const store = readStore();
  if (!(name in store.profiles)) return;
  const profiles = { ...store.profiles };
  delete profiles[name];
  writeStore({
    ...store,
    profiles,
    currentProfile: store.currentProfile === name ? null : store.currentProfile,
  });
}

/**
 * Set the active profile. Pass `null` to clear.
 */
export function setCurrentProfile(name: string | null): void {
  const store = readStore();
  writeStore({ ...store, currentProfile: name });
}

/**
 * Set a value in the global `defaults` map.
 */
export function setDefault<K extends keyof Defaults>(key: K, value: Defaults[K]): void {
  const store = readStore();
  writeStore({ ...store, defaults: { ...store.defaults, [key]: value } });
}

/**
 * Remove a key from the global `defaults` map.
 * Returns the previous value (or `undefined` if the key was not set).
 */
export function unsetDefault(key: keyof Defaults): { previous: unknown } {
  const store = readStore();
  const previous = store.defaults[key];
  const defaults = { ...store.defaults };
  delete defaults[key];
  writeStore({ ...store, defaults });
  return { previous };
}

/**
 * Update the `apiBaseUrl` for a specific profile.
 * Throws `ConfigError({ kind: 'missing-profile' })` if the profile doesn't exist.
 */
export function setProfileApiBaseUrl(name: string, url: string): void {
  const store = readStore();
  const existing = store.profiles[name];
  if (!existing) {
    throw new ConfigError(`Profile '${name}' does not exist in the conf store.`, {
      kind: 'missing-profile',
      profile: name,
    });
  }
  writeStore({
    ...store,
    profiles: { ...store.profiles, [name]: { ...existing, apiBaseUrl: url } },
  });
}

/**
 * Return the directory used for the fallback tokens file.
 * Guaranteed to exist (created if necessary).
 */
export async function ensureConfDir(): Promise<string> {
  const dir = getConfDir();
  if (!existsSync(dir)) {
    await mkdir(dir, { recursive: true });
  }
  return dir;
}

/**
 * Read the fallback tokens file. Returns an empty record when it doesn't exist.
 */
export async function readTokensFile(): Promise<Record<string, string>> {
  const tokensPath = join(getConfDir(), 'tokens.json');
  try {
    const raw = await readFile(tokensPath, 'utf8');
    return JSON.parse(raw) as Record<string, string>;
  } catch {
    return {};
  }
}

/**
 * Write the fallback tokens file at 0600.
 */
export async function writeTokensFile(tokens: Record<string, string>): Promise<void> {
  const dir = await ensureConfDir();
  const tokensPath = join(dir, 'tokens.json');
  await writeFile(tokensPath, JSON.stringify(tokens, null, 2), {
    mode: 0o600,
    encoding: 'utf8',
  });
  // On Windows chmodSync is a no-op for file permissions, but we still call it
  // for cross-platform parity.
  try {
    chmodSync(tokensPath, 0o600);
  } catch {
    // Ignore — Windows does not support POSIX permissions.
  }
}
