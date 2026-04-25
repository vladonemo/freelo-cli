import { describe, expect, it } from 'vitest';
import { UserMeEnvelopeSchema } from '../../../src/api/schemas/users-me.js';

/**
 * Tests for UserMeEnvelopeSchema — zod schema for GET /users/me responses.
 */
describe('UserMeEnvelopeSchema', () => {
  it('parses the minimal fixture with only result + user.id', () => {
    const minimal = { result: 'success', user: { id: 12345 } };
    const parsed = UserMeEnvelopeSchema.parse(minimal);
    expect(parsed.user.id).toBe(12345);
    expect(parsed.result).toBe('success');
  });

  it('preserves passthrough fields on the user object', () => {
    const extended = {
      result: 'success',
      user: { id: 12345, email: 'jane@example.cz', fullname: 'Jane Doe' },
    };
    const parsed = UserMeEnvelopeSchema.parse(extended);
    expect((parsed.user as Record<string, unknown>)['email']).toBe('jane@example.cz');
    expect((parsed.user as Record<string, unknown>)['fullname']).toBe('Jane Doe');
  });

  it('preserves passthrough fields at the envelope level', () => {
    const withExtra = { result: 'success', user: { id: 1 }, extra_top_level: true };
    const parsed = UserMeEnvelopeSchema.parse(withExtra);
    expect((parsed as Record<string, unknown>)['extra_top_level']).toBe(true);
  });

  it('fails when user.id is missing', () => {
    const bad = { result: 'success', user: { name: 'oops' } };
    const result = UserMeEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fails when user is missing entirely', () => {
    const bad = { result: 'success' };
    const result = UserMeEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fails when user.id is not a positive integer', () => {
    const bad = { result: 'success', user: { id: -1 } };
    const result = UserMeEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('fails when user.id is a float', () => {
    const bad = { result: 'success', user: { id: 1.5 } };
    const result = UserMeEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });
});
