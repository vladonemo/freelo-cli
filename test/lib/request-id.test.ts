import { describe, expect, it } from 'vitest';
import { generateRequestId, parseRequestId } from '../../src/lib/request-id.js';
import { ValidationError } from '../../src/errors/validation-error.js';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe('generateRequestId', () => {
  it('returns a string matching the UUID v4 pattern', () => {
    const id = generateRequestId();
    expect(UUID_V4_RE.test(id)).toBe(true);
  });

  it('returns a different value on each call', () => {
    const a = generateRequestId();
    const b = generateRequestId();
    expect(a).not.toBe(b);
  });
});

describe('parseRequestId', () => {
  it('returns the input unchanged when it is a valid v4 UUID', () => {
    const valid = '550e8400-e29b-41d4-a716-446655440000';
    expect(parseRequestId(valid)).toBe(valid);
  });

  it('is case-insensitive for hex digits', () => {
    const upper = '550E8400-E29B-41D4-A716-446655440000';
    expect(parseRequestId(upper)).toBe(upper);
  });

  it('throws ValidationError when input is not a UUID', () => {
    expect(() => parseRequestId('not-a-uuid')).toThrow(ValidationError);
  });

  it('throws ValidationError with field request-id on bad input', () => {
    try {
      parseRequestId('bad');
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).field).toBe('request-id');
    }
  });

  it('throws ValidationError when input is a v1 UUID (version digit is not 4)', () => {
    // v1 UUID has '1' in the version position
    expect(() => parseRequestId('550e8400-e29b-11d4-a716-446655440000')).toThrow(ValidationError);
  });

  it('throws ValidationError on empty string', () => {
    expect(() => parseRequestId('')).toThrow(ValidationError);
  });
});
