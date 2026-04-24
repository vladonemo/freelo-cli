import { BaseError, type BaseErrorOptions } from './base.js';

/**
 * Discriminated-union kind for `ConfigError`. Each `kind` maps to a specific
 * exit code and hint so callers and renderers can treat them separately without
 * a long if/else chain.
 */
export type ConfigErrorKind =
  | { kind: 'missing-token'; profile: string }
  | { kind: 'missing-profile'; profile: string }
  | { kind: 'keychain-unavailable'; path: string }
  | { kind: 'corrupt-config'; path: string };

type ConfigErrorCode = 'AUTH_MISSING' | 'CONFIG_ERROR';

function resolveFields(kindData: ConfigErrorKind): {
  code: ConfigErrorCode;
  exitCode: number;
  hintNext: string;
} {
  switch (kindData.kind) {
    case 'missing-token':
      return {
        code: 'AUTH_MISSING',
        exitCode: 3,
        hintNext: `Run 'freelo auth login' or set FREELO_API_KEY + FREELO_EMAIL.`,
      };
    case 'missing-profile':
      return {
        code: 'AUTH_MISSING',
        exitCode: 3,
        hintNext: `Run 'freelo auth login --profile ${kindData.profile}' to create it.`,
      };
    case 'keychain-unavailable':
      return {
        code: 'CONFIG_ERROR',
        exitCode: 1,
        hintNext: `Install libsecret (Linux) or check the file permissions at ${kindData.path}.`,
      };
    case 'corrupt-config':
      return {
        code: 'CONFIG_ERROR',
        exitCode: 1,
        hintNext: `Delete or repair the config file at ${kindData.path} and run 'freelo auth login' again.`,
      };
  }
}

/**
 * Thrown when the CLI's own configuration (persistent user config, credential
 * store, profile resolution) is malformed or missing a value the CLI needs.
 *
 * The `kind` discriminant determines the exact exit code:
 *   - `missing-token` / `missing-profile` → exit 3 (`AUTH_MISSING`)
 *   - `corrupt-config` / `keychain-unavailable` → exit 1 (`CONFIG_ERROR`)
 *
 * Not retryable: retrying won't fix a missing credential or a malformed config.
 */
export class ConfigError extends BaseError {
  readonly kind: ConfigErrorKind;
  readonly code: ConfigErrorCode;
  readonly exitCode: number;
  readonly retryable = false;

  constructor(message: string, kindData: ConfigErrorKind, options?: BaseErrorOptions) {
    const { code, exitCode, hintNext } = resolveFields(kindData);
    super(message, { ...options, hintNext: options?.hintNext ?? hintNext });
    this.kind = kindData;
    this.code = code;
    this.exitCode = exitCode;
  }
}
