import { describe, expect, it } from 'vitest';
import { scrubSecrets } from '../../src/errors/redact.js';

/**
 * Tests for scrubSecrets — deep-clone with redaction of secret keys.
 */
describe('scrubSecrets', () => {
  it('redacts authorization key at the top level', () => {
    const result = scrubSecrets({ authorization: 'Bearer secret' }) as Record<string, unknown>;
    expect(result['authorization']).toBe('[redacted]');
  });

  it('redacts password key at the top level', () => {
    const result = scrubSecrets({ password: 'hunter2' }) as Record<string, unknown>;
    expect(result['password']).toBe('[redacted]');
  });

  it('redacts api_key at the top level', () => {
    const result = scrubSecrets({ api_key: 'sk-abc' }) as Record<string, unknown>;
    expect(result['api_key']).toBe('[redacted]');
  });

  it('redacts camelCase apiKey at the top level', () => {
    const result = scrubSecrets({ apiKey: 'sk-abc' }) as Record<string, unknown>;
    expect(result['apiKey']).toBe('[redacted]');
  });

  it('redacts apiKey case-insensitively (APIKEY, ApiKey, apikey)', () => {
    const result = scrubSecrets({
      APIKEY: 'a',
      ApiKey: 'b',
      apikey: 'c',
    }) as Record<string, unknown>;
    expect(result['APIKEY']).toBe('[redacted]');
    expect(result['ApiKey']).toBe('[redacted]');
    expect(result['apikey']).toBe('[redacted]');
  });

  it('redacts token at the top level', () => {
    const result = scrubSecrets({ token: 'tok-xyz' }) as Record<string, unknown>;
    expect(result['token']).toBe('[redacted]');
  });

  it('redacts email at the top level', () => {
    const result = scrubSecrets({ email: 'user@example.com' }) as Record<string, unknown>;
    expect(result['email']).toBe('[redacted]');
  });

  it('preserves non-secret sibling keys', () => {
    const result = scrubSecrets({ password: 'secret', name: 'Alice' }) as Record<string, unknown>;
    expect(result['name']).toBe('Alice');
    expect(result['password']).toBe('[redacted]');
  });

  it('redacts secret keys nested inside objects', () => {
    const result = scrubSecrets({
      outer: {
        inner: { authorization: 'Bearer tok' },
      },
    }) as { outer: { inner: { authorization: string } } };
    expect(result.outer.inner.authorization).toBe('[redacted]');
  });

  it('redacts secret keys inside arrays of objects', () => {
    const result = scrubSecrets([{ token: 'abc' }, { other: 'x' }]) as Array<
      Record<string, unknown>
    >;
    expect(result[0]!['token']).toBe('[redacted]');
    expect(result[1]!['other']).toBe('x');
  });

  it('leaves primitive non-secret values unchanged', () => {
    expect(scrubSecrets(42)).toBe(42);
    expect(scrubSecrets('hello')).toBe('hello');
    expect(scrubSecrets(null)).toBeNull();
    expect(scrubSecrets(true)).toBe(true);
  });

  it('returns an empty object unchanged', () => {
    expect(scrubSecrets({})).toEqual({});
  });

  it('does not mutate the input object', () => {
    const input = { password: 'secret', safe: 'data' };
    scrubSecrets(input);
    expect(input.password).toBe('secret');
  });

  it('is case-insensitive for key matching', () => {
    // The implementation lowercases keys for comparison
    const result = scrubSecrets({ Authorization: 'Bearer tok' }) as Record<string, unknown>;
    // Note: key case is preserved in the output, but the value is redacted
    const values = Object.values(result);
    expect(values).toContain('[redacted]');
  });
});
