import { describe, expect, it } from 'vitest';
import { RcConfigSchema } from '../../src/config/rc-schema.js';

describe('RcConfigSchema — valid values', () => {
  it('accepts an empty object', () => {
    expect(RcConfigSchema.parse({})).toEqual({});
  });

  it('accepts valid output values', () => {
    for (const output of ['auto', 'human', 'json', 'ndjson']) {
      expect(RcConfigSchema.parse({ output })).toEqual({ output });
    }
  });

  it('accepts valid color values', () => {
    for (const color of ['auto', 'never', 'always']) {
      expect(RcConfigSchema.parse({ color })).toEqual({ color });
    }
  });

  it('accepts a non-empty profile string', () => {
    expect(RcConfigSchema.parse({ profile: 'ci' })).toEqual({ profile: 'ci' });
  });

  it('accepts a valid apiBaseUrl', () => {
    const url = 'https://staging.freelo.io/v1';
    expect(RcConfigSchema.parse({ apiBaseUrl: url })).toEqual({ apiBaseUrl: url });
  });

  it('accepts numeric verbose 0, 1, 2', () => {
    for (const verbose of [0, 1, 2]) {
      expect(RcConfigSchema.parse({ verbose })).toEqual({ verbose });
    }
  });

  it('accepts all writable fields together', () => {
    const rc = { output: 'json', color: 'never', profile: 'ci', verbose: 1 };
    expect(RcConfigSchema.parse(rc)).toEqual(rc);
  });
});

describe('RcConfigSchema — invalid values', () => {
  it('rejects unknown key (e.g. apiKey)', () => {
    expect(() => RcConfigSchema.parse({ apiKey: 'sk-...' })).toThrow();
  });

  it('rejects unknown key email', () => {
    expect(() => RcConfigSchema.parse({ email: 'user@example.com' })).toThrow();
  });

  it('rejects unknown key token', () => {
    expect(() => RcConfigSchema.parse({ token: 'abc' })).toThrow();
  });

  it('rejects invalid output value', () => {
    expect(() => RcConfigSchema.parse({ output: 'yaml' })).toThrow();
  });

  it('rejects invalid color value', () => {
    expect(() => RcConfigSchema.parse({ color: 'yes' })).toThrow();
  });

  it('rejects empty profile string', () => {
    expect(() => RcConfigSchema.parse({ profile: '' })).toThrow();
  });

  it('rejects non-URL apiBaseUrl', () => {
    expect(() => RcConfigSchema.parse({ apiBaseUrl: 'not-a-url' })).toThrow();
  });

  it('rejects verbose value 3', () => {
    expect(() => RcConfigSchema.parse({ verbose: 3 })).toThrow();
  });

  it('rejects verbose as string (string form is for CLI wire only)', () => {
    expect(() => RcConfigSchema.parse({ verbose: '1' })).toThrow();
  });

  it('rejects Shape B (profiles key) as unknown', () => {
    expect(() =>
      RcConfigSchema.parse({ profile: 'ci', profiles: { ci: { output: 'json' } } }),
    ).toThrow();
  });
});
