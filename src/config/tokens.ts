import { join } from 'node:path';
import { type Logger } from 'pino';
import { readTokensFile, writeTokensFile, getConfDir } from './store.js';

/**
 * Module-level flag: set to true once keytar fails to import or throws a
 * non-ENOENT error.  Subsequent calls skip the import entirely.
 */
let keytarUnavailable = false;

/** Set internally on first fallback activation; cleared between tests. */
let fallbackWarningEmitted = false;

/** Exported for test teardown. */
export function _resetKeytarState(): void {
  keytarUnavailable = false;
  fallbackWarningEmitted = false;
}

const SERVICE = 'freelo-cli';

/**
 * Emit a one-shot warning the first time we fall back to the file store.
 */
function emitFallbackWarning(
  path: string,
  mode: 'human' | 'json' | 'ndjson',
  logger?: Logger,
): void {
  if (fallbackWarningEmitted) return;
  fallbackWarningEmitted = true;
  if (mode === 'human') {
    process.stderr.write(
      `warning: OS keychain unavailable; storing token in ${path} (0600). Install libsecret for better security.\n`,
    );
  } else if (logger) {
    logger.warn({ path }, 'OS keychain unavailable; storing token in fallback file (0600).');
  }
}

/**
 * Attempt to load and return the keytar module.
 * Returns `null` if `FREELO_NO_KEYCHAIN=1` or if the import fails.
 */
type KeytarApi = {
  getPassword(service: string, account: string): Promise<string | null>;
  setPassword(service: string, account: string, password: string): Promise<void>;
  deletePassword(service: string, account: string): Promise<boolean>;
};

async function tryKeytar(): Promise<KeytarApi | null> {
  if (process.env['FREELO_NO_KEYCHAIN'] === '1') return null;
  if (keytarUnavailable) return null;
  try {
    return await import('keytar');
  } catch {
    keytarUnavailable = true;
    return null;
  }
}

/**
 * Read the API key for a profile.
 *
 * Precedence: keytar → fallback tokens.json.
 * Returns `null` if not found in either store.
 */
export async function readToken(profile: string): Promise<string | null> {
  const kt = await tryKeytar();
  if (kt) {
    try {
      const result = await kt.getPassword(SERVICE, profile);
      if (result !== null) return result;
    } catch {
      keytarUnavailable = true;
    }
  }
  // Fallback file
  const tokens = await readTokensFile();
  return tokens[profile] ?? null;
}

/**
 * Persist an API key for a profile in both stores where available.
 *
 * - Tries keytar first; on failure marks unavailable and falls back.
 * - Fallback file written at 0600.
 */
export async function writeToken(
  profile: string,
  apiKey: string,
  opts?: { mode?: 'human' | 'json' | 'ndjson'; logger?: Logger },
): Promise<void> {
  const mode = opts?.mode ?? 'json';
  const kt = await tryKeytar();
  if (kt) {
    try {
      await kt.setPassword(SERVICE, profile, apiKey);
      return;
    } catch {
      keytarUnavailable = true;
    }
  }
  // Fallback file
  const tokens = await readTokensFile();
  tokens[profile] = apiKey;
  const fallbackPath = join(getConfDir(), 'tokens.json');
  emitFallbackWarning(fallbackPath, mode, opts?.logger);
  await writeTokensFile(tokens);
}

/**
 * Delete the API key for a profile from both stores.
 * Swallows "not found" errors from either store.
 */
export async function deleteToken(profile: string): Promise<void> {
  const kt = await tryKeytar();
  if (kt) {
    try {
      await kt.deletePassword(SERVICE, profile);
    } catch {
      // Swallow — either not found or keytar unavailable.
      keytarUnavailable = true;
    }
  }
  // Always attempt the fallback file deletion too.
  try {
    const tokens = await readTokensFile();
    if (profile in tokens) {
      delete tokens[profile];
      await writeTokensFile(tokens);
    }
  } catch {
    // Swallow — file may not exist.
  }
}
