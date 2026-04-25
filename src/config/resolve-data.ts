import { type PartialAppConfig, type ProfileSource, type SourceLiteral } from './schema.js';
import { type SourceMap } from './resolve.js';

/**
 * The flat (non-annotated) form of the resolve envelope data.
 * `apiKey` is always `"[redacted]"` — never the real value.
 */
export type AppConfigPublic = {
  profile: string;
  profileSource: ProfileSource;
  email: string;
  apiKey: '[redacted]';
  apiBaseUrl: string;
  userAgent: string;
  output: {
    mode: 'human' | 'json' | 'ndjson';
    color: 'auto' | 'never' | 'always';
  };
  verbose: 0 | 1 | 2;
  yes: boolean;
  requestId: string;
  has_token: boolean;
};

type Annotated<T> = { value: T; source: SourceLiteral };

/**
 * The `--show-source` annotated form. Every leaf becomes `{ value, source }`.
 * `output` is annotated leaf-wise (mode and color separately).
 */
export type ConfigResolveAnnotated = {
  profile: Annotated<string>;
  profileSource: Annotated<ProfileSource>;
  email: Annotated<string>;
  apiKey: Annotated<'[redacted]'>;
  apiBaseUrl: Annotated<string>;
  userAgent: Annotated<string>;
  output: {
    mode: Annotated<'human' | 'json' | 'ndjson'>;
    color: Annotated<'auto' | 'never' | 'always'>;
  };
  verbose: Annotated<0 | 1 | 2>;
  yes: Annotated<boolean>;
  requestId: Annotated<string>;
  has_token: Annotated<boolean>;
};

export type ConfigResolveData = AppConfigPublic | ConfigResolveAnnotated;

/**
 * Build the data payload for `freelo.config.resolve/v1`.
 *
 * Two branches controlled by `opts.showSource`:
 * - `false` (default): flat `AppConfigPublic` shape, `apiKey` always `"[redacted]"`.
 * - `true`: annotated shape, every leaf is `{ value, source }`.
 *
 * `email` comes from the active profile's store record (not from PartialAppConfig,
 * which omits credentials). Callers pass it in; it defaults to `""` when no
 * profile is configured (§8.6.3).
 *
 * `has_token` is a `boolean` derived from keytar/tokens.json presence, not a
 * decrypted value. It lets agents know "is there a stored token?" without HTTP.
 *
 * Redaction lives here, not in the renderer (defence-in-depth per spec §8.5 rule 3).
 */
export function buildConfigResolveData(
  partial: PartialAppConfig,
  email: string,
  hasToken: boolean,
  sourceMap: SourceMap,
  opts: { showSource: boolean },
): ConfigResolveData {
  if (!opts.showSource) {
    // Flat shape
    const data: AppConfigPublic = {
      profile: partial.profile,
      profileSource: partial.profileSource,
      email,
      apiKey: '[redacted]',
      apiBaseUrl: partial.apiBaseUrl,
      userAgent: partial.userAgent,
      output: {
        mode: partial.output.mode,
        color: partial.output.color,
      },
      verbose: partial.verbose,
      yes: partial.yes,
      requestId: partial.requestId,
      has_token: hasToken,
    };
    return data;
  }

  // Annotated shape
  const emailSource: SourceLiteral = email ? 'conf' : 'default';
  const data: ConfigResolveAnnotated = {
    profile: { value: partial.profile, source: sourceMap.profile },
    // profileSource has no further source to attribute — it is derived
    profileSource: { value: partial.profileSource, source: 'derived' },
    email: { value: email, source: emailSource },
    apiKey: { value: '[redacted]', source: hasToken ? 'conf' : 'default' },
    apiBaseUrl: { value: partial.apiBaseUrl, source: sourceMap.apiBaseUrl },
    userAgent: { value: partial.userAgent, source: 'default' },
    output: {
      mode: { value: partial.output.mode, source: sourceMap.output.mode },
      color: { value: partial.output.color, source: sourceMap.output.color },
    },
    verbose: { value: partial.verbose, source: sourceMap.verbose },
    yes: { value: partial.yes, source: sourceMap.yes },
    requestId: { value: partial.requestId, source: sourceMap.requestId },
    has_token: { value: hasToken, source: 'default' },
  };
  return data;
}
