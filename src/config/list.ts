import { type PartialAppConfig, type ProfileSource } from './schema.js';
import { type SourceMap } from './resolve.js';

export type ConfigKeyEntry = {
  key: string;
  value: string | number | boolean | null;
  source: ProfileSource;
  writable: boolean;
};

export type ConfigListData = {
  keys: ConfigKeyEntry[];
};

/**
 * Build the data payload for `freelo.config.list/v1`.
 *
 * Key order is fixed per spec §7 #9:
 *   1. Writable keys, alphabetical: apiBaseUrl, color, output, profile, verbose
 *   2. Read-only keys, alphabetical: apiKey, email, profileSource, requestId, userAgent, yes
 *
 * `apiKey` value is always the literal string `"[redacted]"` — defence in depth,
 * per spec §8.5 rule 3.
 *
 * `has_token` is used to derive the `apiKey` source annotation — if a token
 * exists, source is 'conf'; otherwise 'default'.
 */
export function buildConfigListData(
  partial: PartialAppConfig,
  sourceMap: SourceMap,
  hasToken: boolean,
): ConfigListData {
  const keys: ConfigKeyEntry[] = [
    // --- Writable (alphabetical) ---
    {
      key: 'apiBaseUrl',
      value: partial.apiBaseUrl,
      source: sourceMap.apiBaseUrl,
      writable: true,
    },
    {
      key: 'color',
      value: partial.output.color,
      source: sourceMap.output.color,
      writable: true,
    },
    {
      key: 'output',
      value: partial.output.mode,
      source: sourceMap.output.mode,
      writable: true,
    },
    {
      key: 'profile',
      value: partial.profile,
      source: sourceMap.profile,
      writable: true,
    },
    {
      key: 'verbose',
      value: String(partial.verbose),
      source: sourceMap.verbose,
      writable: true,
    },
    // --- Read-only (alphabetical) ---
    {
      key: 'apiKey',
      value: '[redacted]',
      source: hasToken ? 'conf' : 'default',
      writable: false,
    },
    {
      key: 'email',
      // email is not in PartialAppConfig; shows as empty string by default
      value: '',
      source: 'default',
      writable: false,
    },
    {
      key: 'profileSource',
      value: partial.profileSource,
      source: 'default',
      writable: false,
    },
    {
      key: 'requestId',
      value: partial.requestId,
      source: sourceMap.requestId,
      writable: false,
    },
    {
      key: 'userAgent',
      value: partial.userAgent,
      source: 'default',
      writable: false,
    },
    {
      key: 'yes',
      value: partial.yes,
      source: sourceMap.yes,
      writable: false,
    },
  ];

  return { keys };
}
