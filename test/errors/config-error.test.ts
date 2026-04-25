import { describe, expect, it } from 'vitest';
import { ConfigError } from '../../src/errors/config-error.js';

/**
 * Tests for ConfigError — each kind maps to the correct code, exitCode, hintNext.
 */
describe('ConfigError — missing-token kind', () => {
  it('has code AUTH_MISSING', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    expect(err.code).toBe('AUTH_MISSING');
  });

  it('has exitCode 3', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    expect(err.exitCode).toBe(3);
  });

  it('is not retryable', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    expect(err.retryable).toBe(false);
  });

  it('includes freelo auth login in hintNext', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    expect(err.hintNext).toContain('freelo auth login');
  });

  it('exposes the kind discriminant', () => {
    const err = new ConfigError('no token', { kind: 'missing-token', profile: 'default' });
    expect(err.kind.kind).toBe('missing-token');
  });
});

describe('ConfigError — missing-profile kind', () => {
  it('has code AUTH_MISSING', () => {
    const err = new ConfigError('no profile', { kind: 'missing-profile', profile: 'ci' });
    expect(err.code).toBe('AUTH_MISSING');
  });

  it('has exitCode 3', () => {
    const err = new ConfigError('no profile', { kind: 'missing-profile', profile: 'ci' });
    expect(err.exitCode).toBe(3);
  });

  it('includes the profile name in hintNext', () => {
    const err = new ConfigError('no profile', { kind: 'missing-profile', profile: 'ci' });
    expect(err.hintNext).toContain('ci');
  });
});

describe('ConfigError — corrupt-config kind', () => {
  it('has code CONFIG_ERROR', () => {
    const err = new ConfigError('bad json', { kind: 'corrupt-config', path: '/etc/config.json' });
    expect(err.code).toBe('CONFIG_ERROR');
  });

  it('has exitCode 1', () => {
    const err = new ConfigError('bad json', { kind: 'corrupt-config', path: '/etc/config.json' });
    expect(err.exitCode).toBe(1);
  });

  it('includes the file path in hintNext', () => {
    const err = new ConfigError('bad json', { kind: 'corrupt-config', path: '/etc/config.json' });
    expect(err.hintNext).toContain('/etc/config.json');
  });
});

describe('ConfigError — keychain-unavailable kind', () => {
  it('has code CONFIG_ERROR', () => {
    const err = new ConfigError('keytar failed', {
      kind: 'keychain-unavailable',
      path: '/home/.config/tokens.json',
    });
    expect(err.code).toBe('CONFIG_ERROR');
  });

  it('has exitCode 1', () => {
    const err = new ConfigError('keytar failed', {
      kind: 'keychain-unavailable',
      path: '/home/.config/tokens.json',
    });
    expect(err.exitCode).toBe(1);
  });

  it('includes the path in hintNext', () => {
    const err = new ConfigError('keytar failed', {
      kind: 'keychain-unavailable',
      path: '/home/.config/tokens.json',
    });
    expect(err.hintNext).toContain('/home/.config/tokens.json');
  });
});

describe('ConfigError — caller-provided hintNext overrides default', () => {
  it('respects a custom hintNext passed in options', () => {
    const err = new ConfigError(
      'missing token',
      { kind: 'missing-token', profile: 'x' },
      { hintNext: 'custom hint here' },
    );
    expect(err.hintNext).toBe('custom hint here');
  });
});
