import { describe, expect, it } from 'vitest';
import {
  parseValue,
  keyScope,
  isReadOnlyKey,
  isWritableKey,
  isKnownKey,
  READONLY_KEYS,
  WRITABLE_KEYS,
} from '../../src/config/keys.js';
import { ValidationError } from '../../src/errors/validation-error.js';

describe('parseValue — valid inputs', () => {
  it('parses output: auto', () => {
    expect(parseValue('output', 'auto')).toBe('auto');
  });

  it('parses output: json', () => {
    expect(parseValue('output', 'json')).toBe('json');
  });

  it('parses output: human', () => {
    expect(parseValue('output', 'human')).toBe('human');
  });

  it('parses output: ndjson', () => {
    expect(parseValue('output', 'ndjson')).toBe('ndjson');
  });

  it('parses color: auto', () => {
    expect(parseValue('color', 'auto')).toBe('auto');
  });

  it('parses color: never', () => {
    expect(parseValue('color', 'never')).toBe('never');
  });

  it('parses color: always', () => {
    expect(parseValue('color', 'always')).toBe('always');
  });

  it('parses profile string', () => {
    expect(parseValue('profile', 'ci')).toBe('ci');
  });

  it('parses apiBaseUrl', () => {
    expect(parseValue('apiBaseUrl', 'https://api.freelo.io/v1')).toBe('https://api.freelo.io/v1');
  });

  it('parses verbose "0" → 0', () => {
    expect(parseValue('verbose', '0')).toBe(0);
  });

  it('parses verbose "1" → 1', () => {
    expect(parseValue('verbose', '1')).toBe(1);
  });

  it('parses verbose "2" → 2', () => {
    expect(parseValue('verbose', '2')).toBe(2);
  });
});

describe('parseValue — invalid inputs', () => {
  it('throws ValidationError for invalid output value', () => {
    expect(() => parseValue('output', 'yaml')).toThrow(ValidationError);
  });

  it('throws ValidationError for invalid color value', () => {
    expect(() => parseValue('color', 'on')).toThrow(ValidationError);
  });

  it('throws ValidationError for empty profile', () => {
    expect(() => parseValue('profile', '')).toThrow(ValidationError);
  });

  it('throws ValidationError for non-URL apiBaseUrl', () => {
    expect(() => parseValue('apiBaseUrl', 'not-a-url')).toThrow(ValidationError);
  });

  it('throws ValidationError for verbose "3"', () => {
    expect(() => parseValue('verbose', '3')).toThrow(ValidationError);
  });

  it('throws ValidationError for verbose non-numeric string', () => {
    expect(() => parseValue('verbose', 'high')).toThrow(ValidationError);
  });
});

describe('keyScope', () => {
  it('output → defaults', () => {
    expect(keyScope('output')).toBe('defaults');
  });

  it('color → defaults', () => {
    expect(keyScope('color')).toBe('defaults');
  });

  it('verbose → defaults', () => {
    expect(keyScope('verbose')).toBe('defaults');
  });

  it('apiBaseUrl → profile', () => {
    expect(keyScope('apiBaseUrl')).toBe('profile');
  });

  it('profile → currentProfile', () => {
    expect(keyScope('profile')).toBe('currentProfile');
  });
});

describe('isReadOnlyKey', () => {
  it('returns true for each readonly key', () => {
    for (const key of READONLY_KEYS) {
      expect(isReadOnlyKey(key)).toBe(true);
    }
  });

  it('returns false for writable keys', () => {
    for (const key of Object.keys(WRITABLE_KEYS)) {
      expect(isReadOnlyKey(key)).toBe(false);
    }
  });

  it('returns false for unknown keys', () => {
    expect(isReadOnlyKey('fooBar')).toBe(false);
  });
});

describe('isWritableKey', () => {
  it('returns true for each writable key', () => {
    for (const key of Object.keys(WRITABLE_KEYS)) {
      expect(isWritableKey(key)).toBe(true);
    }
  });

  it('returns false for readonly keys', () => {
    for (const key of READONLY_KEYS) {
      expect(isWritableKey(key)).toBe(false);
    }
  });

  it('returns false for unknown keys', () => {
    expect(isWritableKey('fooBar')).toBe(false);
  });
});

describe('isKnownKey', () => {
  it('returns true for writable keys', () => {
    expect(isKnownKey('output')).toBe(true);
  });

  it('returns true for readonly keys', () => {
    expect(isKnownKey('apiKey')).toBe(true);
  });

  it('returns false for unknown keys', () => {
    expect(isKnownKey('fooBar')).toBe(false);
  });
});
