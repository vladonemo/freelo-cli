import { BaseError, type BaseErrorOptions } from './base.js';

export type ValidationErrorOptions = BaseErrorOptions & {
  readonly field?: string;
  readonly value?: unknown;
};

/**
 * Thrown for bad CLI input: invalid flag value, conflicting flags, failed
 * argument validation, etc. Maps to exit code 2 (usage error).
 */
export class ValidationError extends BaseError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly exitCode = 2;
  readonly retryable = false;
  readonly field?: string;
  readonly value?: unknown;

  constructor(message: string, options?: ValidationErrorOptions) {
    super(message, options);
    if (options?.field !== undefined) this.field = options.field;
    if (options?.value !== undefined) this.value = options.value;
  }
}
