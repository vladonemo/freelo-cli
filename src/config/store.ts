import { join } from 'node:path';
import { chmodSync, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import Conf from 'conf';
import { type ConfStore, ConfStoreSchema } from './schema.js';
import { ConfigError } from '../errors/config-error.js';

/**
 * Default store contents for a fresh install.
 */
const DEFAULT_STORE: ConfStore = {
  schemaVersion: 1,
  currentProfile: null,
  profiles: {},
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
 * Read and validate the full store. Returns `DEFAULT_STORE` when the conf file
 * does not exist yet (fresh install).
 *
 * Throws `ConfigError({ kind: 'corrupt-config' })` when the file exists but
 * fails the zod schema.
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

  const result = ConfStoreSchema.safeParse(raw);
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
