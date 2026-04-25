import { readToken } from './tokens.js';

/**
 * Returns `true` when a token exists for the given profile in keytar or the
 * fallback tokens.json file. Returns `false` otherwise.
 *
 * This is a read-only check — no HTTP calls, no token decryption into any
 * envelope. Used by `config resolve` and `config list` to populate the
 * `has_token` field so agents can determine credential presence without
 * calling `auth whoami`.
 */
export async function hasToken(profile: string): Promise<boolean> {
  const token = await readToken(profile);
  return token !== null;
}
