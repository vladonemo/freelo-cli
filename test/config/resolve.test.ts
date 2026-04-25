import { afterEach, describe, expect, it } from 'vitest';
import { buildPartialAppConfig, buildSourceMap } from '../../src/config/resolve.js';

/**
 * Tests for buildPartialAppConfig — precedence for each flag/env axis.
 */
describe('buildPartialAppConfig — output mode precedence', () => {
  afterEach(() => {
    delete process.env['FREELO_OUTPUT'];
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  });

  it('uses CLI flag when --output is provided', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({ env: {}, flags: { output: 'human' } });
    expect(config.output.mode).toBe('human');
  });

  it('uses FREELO_OUTPUT env when no CLI flag', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({ env: { FREELO_OUTPUT: 'ndjson' }, flags: {} });
    expect(config.output.mode).toBe('ndjson');
  });

  it('CLI flag beats FREELO_OUTPUT env', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({
      env: { FREELO_OUTPUT: 'ndjson' },
      flags: { output: 'json' },
    });
    expect(config.output.mode).toBe('json');
  });

  it('resolves auto to json when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.output.mode).toBe('json');
  });

  it('resolves auto to human when stdout is a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: true });
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.output.mode).toBe('human');
  });

  it('ignores invalid output mode values and falls back to auto', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({ env: { FREELO_OUTPUT: 'invalid-mode' }, flags: {} });
    expect(config.output.mode).toBe('json'); // auto resolved to json (non-TTY)
  });
});

describe('buildPartialAppConfig — profile precedence', () => {
  afterEach(() => {
    delete process.env['FREELO_PROFILE'];
  });

  it('uses the CLI --profile flag when provided', () => {
    const config = buildPartialAppConfig({ env: {}, flags: { profile: 'ci' } });
    expect(config.profile).toBe('ci');
    expect(config.profileSource).toBe('flag');
  });

  it('uses FREELO_PROFILE env when no CLI flag', () => {
    const config = buildPartialAppConfig({ env: { FREELO_PROFILE: 'staging' }, flags: {} });
    expect(config.profile).toBe('staging');
    expect(config.profileSource).toBe('env');
  });

  it('CLI flag beats FREELO_PROFILE env', () => {
    const config = buildPartialAppConfig({
      env: { FREELO_PROFILE: 'staging' },
      flags: { profile: 'production' },
    });
    expect(config.profile).toBe('production');
  });

  it('falls back to default profile when no flag, no env, no conf', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.profile).toBe('default');
  });
});

describe('buildPartialAppConfig — verbose precedence', () => {
  afterEach(() => {
    delete process.env['FREELO_DEBUG'];
  });

  it('sets verbose 2 when FREELO_DEBUG=1', () => {
    const config = buildPartialAppConfig({ env: { FREELO_DEBUG: '1' }, flags: {} });
    expect(config.verbose).toBe(2);
  });

  it('CLI --verbose flag 1 sets verbose 1', () => {
    const config = buildPartialAppConfig({ env: {}, flags: { verbose: 1 } });
    expect(config.verbose).toBe(1);
  });

  it('CLI --verbose flag 2 sets verbose 2', () => {
    const config = buildPartialAppConfig({ env: {}, flags: { verbose: 2 } });
    expect(config.verbose).toBe(2);
  });

  it('FREELO_DEBUG=1 beats CLI --verbose 1', () => {
    // FREELO_DEBUG wins by being checked first
    const config = buildPartialAppConfig({ env: { FREELO_DEBUG: '1' }, flags: { verbose: 1 } });
    expect(config.verbose).toBe(2);
  });

  it('defaults to verbose 0 (silent) when nothing is set', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.verbose).toBe(0);
  });
});

describe('buildPartialAppConfig — color mode', () => {
  it('uses CLI --color flag when provided', () => {
    const config = buildPartialAppConfig({ env: {}, flags: { color: 'never' } });
    expect(config.output.color).toBe('never');
  });

  it('uses FREELO_COLOR env when no CLI flag', () => {
    const config = buildPartialAppConfig({ env: { FREELO_COLOR: 'always' }, flags: {} });
    expect(config.output.color).toBe('always');
  });

  it('defaults to auto when no color flag or env', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.output.color).toBe('auto');
  });
});

describe('buildPartialAppConfig — requestId', () => {
  it('generates a request ID when none is provided in flags', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(UUID_V4_RE.test(config.requestId)).toBe(true);
  });

  it('uses the provided requestId flag', () => {
    const id = '550e8400-e29b-41d4-a716-446655440000';
    const config = buildPartialAppConfig({ env: {}, flags: { requestId: id } });
    expect(config.requestId).toBe(id);
  });
});

describe('buildPartialAppConfig — apiBaseUrl', () => {
  afterEach(() => {
    delete process.env['FREELO_API_BASE'];
  });

  it('uses FREELO_API_BASE env override when set', () => {
    const config = buildPartialAppConfig({
      env: { FREELO_API_BASE: 'https://staging.freelo.io/v1' },
      flags: {},
    });
    expect(config.apiBaseUrl).toBe('https://staging.freelo.io/v1');
  });

  it('defaults to the production API base URL', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.apiBaseUrl).toBe('https://api.freelo.io/v1');
  });
});

describe('buildPartialAppConfig — yes flag', () => {
  it('defaults yes to false', () => {
    const config = buildPartialAppConfig({ env: {}, flags: {} });
    expect(config.yes).toBe(false);
  });

  it('sets yes to true when flag is passed', () => {
    const config = buildPartialAppConfig({ env: {}, flags: { yes: true } });
    expect(config.yes).toBe(true);
  });
});

describe('buildPartialAppConfig — rc layer precedence', () => {
  it('rc overrides conf for profile', () => {
    const config = buildPartialAppConfig({
      env: {},
      flags: {},
      rc: { profile: 'rc-profile' },
    });
    expect(config.profile).toBe('rc-profile');
    expect(config.profileSource).toBe('rc');
  });

  it('env beats rc for profile', () => {
    const config = buildPartialAppConfig({
      env: { FREELO_PROFILE: 'env-profile' },
      flags: {},
      rc: { profile: 'rc-profile' },
    });
    expect(config.profile).toBe('env-profile');
    expect(config.profileSource).toBe('env');
  });

  it('flag beats env beats rc for profile', () => {
    const config = buildPartialAppConfig({
      env: { FREELO_PROFILE: 'env-profile' },
      flags: { profile: 'flag-profile' },
      rc: { profile: 'rc-profile' },
    });
    expect(config.profile).toBe('flag-profile');
    expect(config.profileSource).toBe('flag');
  });

  it('rc overrides default for output', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({
      env: {},
      flags: {},
      rc: { output: 'human' },
    });
    expect(config.output.mode).toBe('human');
  });

  it('env beats rc for output', () => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: false });
    const config = buildPartialAppConfig({
      env: { FREELO_OUTPUT: 'ndjson' },
      flags: {},
      rc: { output: 'human' },
    });
    expect(config.output.mode).toBe('ndjson');
  });

  it('rc overrides default for color', () => {
    const config = buildPartialAppConfig({
      env: {},
      flags: {},
      rc: { color: 'never' },
    });
    expect(config.output.color).toBe('never');
  });

  it('rc overrides default for verbose', () => {
    const config = buildPartialAppConfig({
      env: {},
      flags: {},
      rc: { verbose: 2 },
    });
    expect(config.verbose).toBe(2);
  });

  it('rc overrides default for apiBaseUrl', () => {
    const config = buildPartialAppConfig({
      env: {},
      flags: {},
      rc: { apiBaseUrl: 'https://staging.freelo.io/v1' },
    });
    expect(config.apiBaseUrl).toBe('https://staging.freelo.io/v1');
  });

  it('env beats rc for apiBaseUrl', () => {
    const config = buildPartialAppConfig({
      env: { FREELO_API_BASE: 'https://env.freelo.io/v1' },
      flags: {},
      rc: { apiBaseUrl: 'https://rc.freelo.io/v1' },
    });
    expect(config.apiBaseUrl).toBe('https://env.freelo.io/v1');
  });

  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  });
});

describe('buildSourceMap — source attribution', () => {
  afterEach(() => {
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    delete process.env['FREELO_DEBUG'];
  });

  it('all sources are default when nothing is set', () => {
    const map = buildSourceMap({ env: {}, flags: {} });
    expect(map.profile).toBe('default');
    expect(map.output.mode).toBe('default');
    expect(map.output.color).toBe('default');
    expect(map.verbose).toBe('default');
    expect(map.apiBaseUrl).toBe('default');
    expect(map.requestId).toBe('default');
  });

  it('profile source is flag when flag is set', () => {
    const map = buildSourceMap({ env: {}, flags: { profile: 'ci' } });
    expect(map.profile).toBe('flag');
  });

  it('profile source is env when env is set', () => {
    const map = buildSourceMap({ env: { FREELO_PROFILE: 'staging' }, flags: {} });
    expect(map.profile).toBe('env');
  });

  it('profile source is rc when rc is set', () => {
    const map = buildSourceMap({ env: {}, flags: {}, rc: { profile: 'rc-profile' } });
    expect(map.profile).toBe('rc');
  });

  it('output.mode source is rc when rc sets output', () => {
    const map = buildSourceMap({ env: {}, flags: {}, rc: { output: 'json' } });
    expect(map.output.mode).toBe('rc');
  });

  it('verbose source is env when FREELO_DEBUG=1', () => {
    const map = buildSourceMap({ env: { FREELO_DEBUG: '1' }, flags: {} });
    expect(map.verbose).toBe('env');
  });

  it('verbose source is flag when flags.verbose is set', () => {
    const map = buildSourceMap({ env: {}, flags: { verbose: 1 } });
    expect(map.verbose).toBe('flag');
  });

  it('verbose source is rc when rc sets verbose', () => {
    const map = buildSourceMap({ env: {}, flags: {}, rc: { verbose: 2 } });
    expect(map.verbose).toBe('rc');
  });

  it('requestId source is flag when requestId flag is set', () => {
    const map = buildSourceMap({
      env: {},
      flags: { requestId: '550e8400-e29b-41d4-a716-446655440000' },
    });
    expect(map.requestId).toBe('flag');
  });
});
