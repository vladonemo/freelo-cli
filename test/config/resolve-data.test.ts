import { describe, expect, it } from 'vitest';
import { buildConfigResolveData } from '../../src/config/resolve-data.js';
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

describe('buildConfigResolveData — flat shape (showSource: false)', () => {
  it('apiKey is always "[redacted]"', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, 'user@example.cz', true, BASE_SOURCE_MAP, {
      showSource: false,
    });
    expect(data.apiKey).toBe('[redacted]');
  });

  it('has_token reflects the passed boolean (true)', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', true, BASE_SOURCE_MAP, {
      showSource: false,
    });
    expect(data.has_token).toBe(true);
  });

  it('has_token reflects the passed boolean (false)', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: false,
    });
    expect(data.has_token).toBe(false);
  });

  it('email shows empty string when no profile is configured', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: false,
    });
    expect(data.email).toBe('');
  });

  it('email shows the passed email when available', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, 'jane@acme.cz', true, BASE_SOURCE_MAP, {
      showSource: false,
    });
    expect(data.email).toBe('jane@acme.cz');
  });

  it('output is a nested object with mode and color', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: false,
    });
    // In flat mode, output is { mode, color } not annotated
    expect('mode' in data.output).toBe(true);
    expect('color' in data.output).toBe(true);
  });
});

describe('buildConfigResolveData — annotated shape (showSource: true)', () => {
  it('apiKey is always { value: "[redacted]", source }', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: true,
    });
    // In annotated mode, apiKey should be an object
    const apiKey = data.apiKey as { value: string; source: string };
    expect(apiKey.value).toBe('[redacted]');
    expect(typeof apiKey.source).toBe('string');
  });

  it('profileSource has source: "derived"', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: true,
    });
    const ps = data.profileSource as { value: string; source: string };
    expect(ps.source).toBe('derived');
  });

  it('output is annotated leaf-wise (mode and color separately)', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, BASE_SOURCE_MAP, {
      showSource: true,
    });
    const output = data.output as {
      mode: { value: string; source: string };
      color: { value: string; source: string };
    };
    expect(output.mode.value).toBe('json');
    expect(output.mode.source).toBe('default');
    expect(output.color.value).toBe('auto');
    expect(output.color.source).toBe('default');
  });

  it('output.mode source is "rc" when sourceMap says rc', () => {
    const sourceMap: SourceMap = { ...BASE_SOURCE_MAP, output: { mode: 'rc', color: 'default' } };
    const data = buildConfigResolveData(BASE_PARTIAL, '', false, sourceMap, { showSource: true });
    const output = data.output as { mode: { value: string; source: string } };
    expect(output.mode.source).toBe('rc');
  });

  it('has_token is annotated with source: "default"', () => {
    const data = buildConfigResolveData(BASE_PARTIAL, '', true, BASE_SOURCE_MAP, {
      showSource: true,
    });
    const ht = data.has_token as { value: boolean; source: string };
    expect(ht.value).toBe(true);
    expect(ht.source).toBe('default');
  });
});
