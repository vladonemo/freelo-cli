import { describe, expect, it } from 'vitest';
import { validateEmail, validateApiKey } from '../../../src/commands/auth/validators.js';

describe('validateEmail', () => {
  it('returns an error message for an empty string', () => {
    const result = validateEmail('');
    expect(result).toBe('Email is required.');
  });

  it('returns an error message for a whitespace-only string', () => {
    const result = validateEmail('   ');
    expect(result).toBe('Email is required.');
  });

  it('returns true for a valid email address', () => {
    expect(validateEmail('jane@acme.cz')).toBe(true);
  });

  it('returns an error message when the @ symbol is missing', () => {
    const result = validateEmail('janeacme.cz');
    expect(result).toBe('Enter a valid email address.');
  });

  it('returns an error message when the TLD is missing (no dot after @)', () => {
    const result = validateEmail('jane@acme');
    expect(result).toBe('Enter a valid email address.');
  });

  it('returns true for an email with dots in the domain', () => {
    expect(validateEmail('user@sub.domain.example.cz')).toBe(true);
  });

  it('returns true for an email with dots in the local part', () => {
    expect(validateEmail('first.last@example.com')).toBe(true);
  });
});

describe('validateApiKey', () => {
  it('returns an error message for an empty string', () => {
    const result = validateApiKey('');
    expect(result).toBe('API token is required.');
  });

  it('returns an error message for a whitespace-only string', () => {
    const result = validateApiKey('   ');
    expect(result).toBe('API token is required.');
  });

  it('returns true for a single non-whitespace character', () => {
    expect(validateApiKey('x')).toBe(true);
  });

  it('returns true for a long API key string', () => {
    expect(validateApiKey('sk-' + 'a'.repeat(64))).toBe(true);
  });

  it('returns true for a key that has surrounding whitespace (non-empty after trim)', () => {
    expect(validateApiKey('  sk-test  ')).toBe(true);
  });
});
