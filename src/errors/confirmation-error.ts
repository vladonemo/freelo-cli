import { BaseError, type BaseErrorOptions } from './base.js';

/**
 * Thrown when a destructive operation is attempted in non-interactive mode
 * without `--yes`. Exit code 2. Defined in R01; first caller is R13.
 */
export class ConfirmationError extends BaseError {
  readonly code = 'CONFIRMATION_REQUIRED' as const;
  readonly exitCode = 2;
  readonly retryable = false;

  constructor(message: string, options?: BaseErrorOptions) {
    super(message, options);
  }
}
