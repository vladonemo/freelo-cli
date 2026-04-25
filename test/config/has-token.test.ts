import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('hasToken', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('returns true when readToken returns a non-null value', async () => {
    vi.doMock('../../src/config/tokens.js', () => ({
      readToken: vi.fn().mockResolvedValue('sk-test-token'),
    }));
    const { hasToken } = await import('../../src/config/has-token.js');
    const result = await hasToken('default');
    expect(result).toBe(true);
  });

  it('returns false when readToken returns null', async () => {
    vi.doMock('../../src/config/tokens.js', () => ({
      readToken: vi.fn().mockResolvedValue(null),
    }));
    const { hasToken } = await import('../../src/config/has-token.js');
    const result = await hasToken('default');
    expect(result).toBe(false);
  });

  it('passes the profile name to readToken', async () => {
    const readToken = vi.fn().mockResolvedValue('sk-ci-token');
    vi.doMock('../../src/config/tokens.js', () => ({ readToken }));
    const { hasToken } = await import('../../src/config/has-token.js');
    await hasToken('ci');
    expect(readToken).toHaveBeenCalledWith('ci');
  });
});
