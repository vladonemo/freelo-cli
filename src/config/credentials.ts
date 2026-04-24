import { readToken } from './tokens.js';
import { readStore } from './store.js';
import { ConfigError } from '../errors/config-error.js';

export type CredentialSource = 'stdin' | 'env' | 'keytar' | 'conf-fallback';

export type ResolvedCredentials = {
  email: string;
  apiKey: string;
  apiBaseUrl: string;
  source: CredentialSource;
};

export type ResolveCredentialsOptions = {
  profile: string;
  apiBaseUrl: string;
  /** API key provided from stdin (--api-key-stdin). Takes highest precedence. */
  stdinApiKey?: string;
  /** Email provided via --email flag or CLI opts. */
  emailFlag?: string;
};

/**
 * Resolve `{ email, apiKey, apiBaseUrl, source }` using precedence:
 *   1. `stdinApiKey` (from `--api-key-stdin`) — requires `emailFlag`.
 *   2. `FREELO_API_KEY` + `FREELO_EMAIL` env vars.
 *   3. keytar (or fallback file) for the profile.
 *   4. (No per-profile token in conf; conf stores email+baseUrl, not token.)
 *
 * Throws `ConfigError({ kind: 'missing-token', profile })` when no source
 * is available.
 */
export async function resolveCredentials(
  opts: ResolveCredentialsOptions,
): Promise<ResolvedCredentials> {
  const { profile, apiBaseUrl, stdinApiKey, emailFlag } = opts;

  // 1. stdin key
  if (stdinApiKey !== undefined && stdinApiKey !== '') {
    // email must be provided; caller validates this before calling us.
    const email = emailFlag ?? process.env['FREELO_EMAIL'] ?? '';
    return { email, apiKey: stdinApiKey, apiBaseUrl, source: 'stdin' };
  }

  // 2. env
  const envKey = process.env['FREELO_API_KEY'];
  const envEmail = process.env['FREELO_EMAIL'];
  if (envKey && envEmail) {
    return {
      email: emailFlag ?? envEmail,
      apiKey: envKey,
      apiBaseUrl: process.env['FREELO_API_BASE'] ?? apiBaseUrl,
      source: 'env',
    };
  }

  // 3 & 4. keytar / fallback file (stored token)
  const token = await readToken(profile);
  if (token !== null) {
    // Email and apiBaseUrl are stored in conf.
    const store = readStore();
    const profileConf = store.profiles[profile];
    const email = emailFlag ?? profileConf?.email ?? '';
    const base = profileConf?.apiBaseUrl ?? apiBaseUrl;
    return { email, apiKey: token, apiBaseUrl: base, source: 'keytar' };
  }

  throw new ConfigError(
    `No credentials found for profile '${profile}'. Run 'freelo auth login' or set FREELO_API_KEY + FREELO_EMAIL.`,
    { kind: 'missing-token', profile },
  );
}
