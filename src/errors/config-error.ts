import { BaseError } from './base.js';

/**
 * Thrown when the CLI's own configuration (package metadata, persistent
 * user config, resolved project config) is malformed or missing a value
 * the CLI needs.
 *
 * Exit code 3 per `.claude/docs/architecture.md`.
 */
export class ConfigError extends BaseError {
  readonly code = 'CONFIG_ERROR';
  readonly exitCode = 3;
}
