import { randomUUID } from 'node:crypto';
import { ValidationError } from '../errors/validation-error.js';

/**
 * UUID v4 regex. Matches the standard 8-4-4-4-12 hex format.
 */
const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Generate a fresh v4 UUID for use as a request ID. */
export function generateRequestId(): string {
  return randomUUID();
}

/**
 * Validate and return a request ID string.
 * Throws `ValidationError` if `input` is not a valid v4 UUID.
 */
export function parseRequestId(input: string): string {
  if (!UUID_V4_RE.test(input)) {
    throw new ValidationError(
      `Invalid request ID '${input}': must be a UUID v4 (xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx).`,
      { field: 'request-id', value: input },
    );
  }
  return input;
}
