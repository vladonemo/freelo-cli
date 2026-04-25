import { describe, expect, it } from 'vitest';
import { buildConfigListData } from '../../src/config/list.js';
import { type PartialAppConfig } from '../../src/config/schema.js';
import { type SourceMap } from '../../src/config/resolve.js';

const BASE_PARTIAL: PartialAppConfig = {
  profile: 'default',
  profileSource: 'default',
  apiBaseUrl: 'https://api.freelo.io/v1',
  userAgent: 'freelo-cli/0.1.0 (+https://github.com/vladonemo/freelo-cli)',
  output: { mode: 'json', color: 'auto' },
  verbose: 0,
  yes: false,
  requestId: '00000000-0000-4000-a000-000000000000',
};

const BASE_SOURCE_MAP: SourceMap = {
  profile: 'default',
  output: { mode: 'default', color: 'default' },
  verbose: 'default',
  apiBaseUrl: 'default',
  requestId: 'default',
  yes: 'default',
};

describe('buildConfigListData — fixed key order', () => {
  it('writable keys come before read-only keys', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const firstReadonly = data.keys.findIndex((k) => !k.writable);
    const lastWritable = data.keys.map((k) => k.writable).lastIndexOf(true);
    expect(firstReadonly).toBeGreaterThan(lastWritable);
  });

  it('writable keys are in alphabetical order: apiBaseUrl, color, output, profile, verbose', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const writableKeys = data.keys.filter((k) => k.writable).map((k) => k.key);
    expect(writableKeys).toEqual(['apiBaseUrl', 'color', 'output', 'profile', 'verbose']);
  });

  it('read-only keys include apiKey, email, profileSource, requestId, userAgent, yes', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const readonlyKeys = data.keys.filter((k) => !k.writable).map((k) => k.key);
    expect(readonlyKeys).toContain('apiKey');
    expect(readonlyKeys).toContain('email');
    expect(readonlyKeys).toContain('profileSource');
    expect(readonlyKeys).toContain('requestId');
    expect(readonlyKeys).toContain('userAgent');
    expect(readonlyKeys).toContain('yes');
  });
});

describe('buildConfigListData — redaction', () => {
  it('apiKey value is always "[redacted]"', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, true, null);
    const apiKeyEntry = data.keys.find((k) => k.key === 'apiKey');
    expect(apiKeyEntry?.value).toBe('[redacted]');
  });

  it('apiKey source is "conf" when has_token is true', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, true, null);
    const apiKeyEntry = data.keys.find((k) => k.key === 'apiKey');
    expect(apiKeyEntry?.source).toBe('conf');
  });

  it('apiKey source is "default" when has_token is false', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const apiKeyEntry = data.keys.find((k) => k.key === 'apiKey');
    expect(apiKeyEntry?.source).toBe('default');
  });
});

describe('buildConfigListData — email source attribution', () => {
  it('email value is "" and source is "default" for a fresh install (email=null)', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const emailEntry = data.keys.find((k) => k.key === 'email');
    expect(emailEntry?.value).toBe('');
    expect(emailEntry?.source).toBe('default');
  });

  it('email value and source are "conf" when an email string is provided', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, true, 'agent@acme.cz');
    const emailEntry = data.keys.find((k) => k.key === 'email');
    expect(emailEntry?.value).toBe('agent@acme.cz');
    expect(emailEntry?.source).toBe('conf');
  });

  it('email value is "" and source is "default" when empty string is passed', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, '');
    const emailEntry = data.keys.find((k) => k.key === 'email');
    expect(emailEntry?.value).toBe('');
    expect(emailEntry?.source).toBe('default');
  });
});

describe('buildConfigListData — source attribution from sourceMap', () => {
  it('output source is "rc" when sourceMap says rc', () => {
    const sourceMap: SourceMap = {
      ...BASE_SOURCE_MAP,
      output: { mode: 'rc', color: 'default' },
    };
    const data = buildConfigListData(BASE_PARTIAL, sourceMap, false, null);
    const outputEntry = data.keys.find((k) => k.key === 'output');
    expect(outputEntry?.source).toBe('rc');
  });

  it('profile source is "flag" when sourceMap says flag', () => {
    const sourceMap: SourceMap = { ...BASE_SOURCE_MAP, profile: 'flag' };
    const data = buildConfigListData(BASE_PARTIAL, sourceMap, false, null);
    const profileEntry = data.keys.find((k) => k.key === 'profile');
    expect(profileEntry?.source).toBe('flag');
  });
});

describe('buildConfigListData — writable flags', () => {
  it('apiKey is not writable', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const apiKeyEntry = data.keys.find((k) => k.key === 'apiKey');
    expect(apiKeyEntry?.writable).toBe(false);
  });

  it('output is writable', () => {
    const data = buildConfigListData(BASE_PARTIAL, BASE_SOURCE_MAP, false, null);
    const outputEntry = data.keys.find((k) => k.key === 'output');
    expect(outputEntry?.writable).toBe(true);
  });
});
