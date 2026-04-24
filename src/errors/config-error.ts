import { BaseError } from './base.js';

/**
 * Thrown when the CLI's own configuration (package metadata, persistent
 * user config, resolved project config) is malformed or missing a value
 * the CLI needs.
 *
 * Exit code 1 (generic failure) per `.claude/docs/architecture.md` —
 * exit 3 is reserved for auth errors (missing/expired credentials),
 * which get their own `AuthError` class in R01.
 *
 * Not retryable: retrying won't fix a malformed package.json or a
 * missing config key.
 */
export class ConfigError extends BaseError {
  readonly code = 'CONFIG_ERROR';
  readonly exitCode = 1;
  readonly retryable = false;
}
