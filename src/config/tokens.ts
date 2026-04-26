import { readTokensFile, writeTokensFile } from './store.js';

/**
 * Token storage facade.
 *
 * After the keytar removal, `tokens.json` (0600, in `getConfDir()`) is the
 * sole persistent token store. Env-var auth (`FREELO_API_KEY` + `FREELO_EMAIL`)
 * remains the recommended path and is handled in `credentials.ts` — never
 * touches this module.
 *
 * The functions retain their `async` signatures so call sites are unchanged
 * across the keytar removal.
 */

/**
 * Read the API key for a profile from `tokens.json`.
 *
 * Returns `null` when the file is absent or has no entry for the profile.
 */
export async function readToken(profile: string): Promise<string | null> {
  const tokens = await readTokensFile();
  return tokens[profile] ?? null;
}

/**
 * Persist an API key for a profile in `tokens.json` (mode 0600).
 */
export async function writeToken(profile: string, apiKey: string): Promise<void> {
  const tokens = await readTokensFile();
  tokens[profile] = apiKey;
  await writeTokensFile(tokens);
}

/**
 * Delete the API key for a profile from `tokens.json`.
 *
 * Idempotent — does nothing if the file is absent or the profile has no
 * entry. A read failure is swallowed because "file does not exist" is the
 * only expected non-success condition; structural corruption surfaces via
 * the next `readToken` call.
 */
export async function deleteToken(profile: string): Promise<void> {
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
