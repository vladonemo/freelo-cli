import { describe, expect, it } from 'vitest';
import { FreeloErrorBodySchema, normalizeErrors } from '../../../src/api/schemas/error.js';

/**
 * Tests for FreeloErrorBodySchema and normalizeErrors.
 * The Freelo API has two incompatible error shapes:
 *   - /users/me 401: { errors: [{ message: string }] }
 *   - Global ErrorResponse: { errors: string[] }
 */
describe('FreeloErrorBodySchema', () => {
  it('accepts the /users/me 401 shape (array of objects)', () => {
    const body = { errors: [{ message: 'Invalid token' }] };
    const result = FreeloErrorBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('accepts the global ErrorResponse shape (array of strings)', () => {
    const body = { errors: ['Invalid token'] };
    const result = FreeloErrorBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('accepts a mixed array of strings and objects', () => {
    const body = { errors: ['string error', { message: 'object error' }] };
    const result = FreeloErrorBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('accepts passthrough fields at the envelope level', () => {
    const body = { errors: ['msg'], extra: true };
    const result = FreeloErrorBodySchema.safeParse(body);
    expect(result.success).toBe(true);
  });

  it('fails when errors field is missing', () => {
    const bad = { message: 'no errors array' };
    const result = FreeloErrorBodySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fails when errors contains an invalid item (number)', () => {
    const bad = { errors: [42] };
    const result = FreeloErrorBodySchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});

describe('normalizeErrors', () => {
  it('returns strings as-is from the string-array shape', () => {
    const body = FreeloErrorBodySchema.parse({ errors: ['Invalid token'] });
    expect(normalizeErrors(body)).toEqual(['Invalid token']);
  });

  it('extracts the message property from the object-array shape', () => {
    const body = FreeloErrorBodySchema.parse({ errors: [{ message: 'Invalid token' }] });
    expect(normalizeErrors(body)).toEqual(['Invalid token']);
  });

  it('handles multiple errors of both shapes', () => {
    const body = FreeloErrorBodySchema.parse({
      errors: ['first error', { message: 'second error' }],
    });
    expect(normalizeErrors(body)).toEqual(['first error', 'second error']);
  });

  it('returns an empty array when errors is empty', () => {
    const body = FreeloErrorBodySchema.parse({ errors: [] });
    expect(normalizeErrors(body)).toEqual([]);
  });
});
