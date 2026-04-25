import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInteractive, resolveOutputMode, wantsColor } from '../../src/lib/env.js';

/**
 * Tests for src/lib/env.ts — the single module that reads TTY state,
 * NO_COLOR, FORCE_COLOR, CI, and FREELO_OUTPUT.
 */

function setTTY(stdout: boolean, stdin: boolean) {
  Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: stdout });
  Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: stdin });
}

describe('resolveOutputMode', () => {
  afterEach(() => {
    // Restore TTY state to whatever Node uses under vitest (typically undefined)
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  });

  it('returns json when stdout is not a TTY and flag is auto', () => {
    setTTY(false, false);
    expect(resolveOutputMode('auto')).toBe('json');
  });

  it('returns human when stdout is a TTY and flag is auto', () => {
    setTTY(true, true);
    expect(resolveOutputMode('auto')).toBe('human');
  });

  it('passes through json regardless of TTY state', () => {
    setTTY(true, true);
    expect(resolveOutputMode('json')).toBe('json');
  });

  it('passes through human regardless of TTY state', () => {
    setTTY(false, false);
    expect(resolveOutputMode('human')).toBe('human');
  });

  it('passes through ndjson regardless of TTY state', () => {
    setTTY(false, false);
    expect(resolveOutputMode('ndjson')).toBe('ndjson');
  });
});

describe('isInteractive', () => {
  let savedEnvCI: string | undefined;

  beforeEach(() => {
    savedEnvCI = process.env['CI'];
    delete process.env['CI'];
  });

  afterEach(() => {
    if (savedEnvCI !== undefined) {
      process.env['CI'] = savedEnvCI;
    } else {
      delete process.env['CI'];
    }
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
    Object.defineProperty(process.stdin, 'isTTY', { configurable: true, value: undefined });
  });

  it('returns true when both stdout and stdin are TTYs and CI is unset', () => {
    setTTY(true, true);
    expect(isInteractive()).toBe(true);
  });

  it('returns false when stdout is not a TTY', () => {
    setTTY(false, true);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when stdin is not a TTY', () => {
    setTTY(true, false);
    expect(isInteractive()).toBe(false);
  });

  it('returns false when CI=true even if both streams are TTYs', () => {
    setTTY(true, true);
    process.env['CI'] = 'true';
    expect(isInteractive()).toBe(false);
  });

  it('returns false when CI=1 even if both streams are TTYs', () => {
    setTTY(true, true);
    process.env['CI'] = '1';
    expect(isInteractive()).toBe(false);
  });

  it('does not treat CI=0 as CI being set (returns true on TTY)', () => {
    setTTY(true, true);
    process.env['CI'] = '0';
    expect(isInteractive()).toBe(true);
  });

  it('does not treat CI=false as CI being set (returns true on TTY)', () => {
    setTTY(true, true);
    process.env['CI'] = 'false';
    expect(isInteractive()).toBe(true);
  });
});

describe('wantsColor', () => {
  let savedNoColor: string | undefined;
  let savedForceColor: string | undefined;

  beforeEach(() => {
    savedNoColor = process.env['NO_COLOR'];
    savedForceColor = process.env['FORCE_COLOR'];
    delete process.env['NO_COLOR'];
    delete process.env['FORCE_COLOR'];
  });

  afterEach(() => {
    if (savedNoColor !== undefined) {
      process.env['NO_COLOR'] = savedNoColor;
    } else {
      delete process.env['NO_COLOR'];
    }
    if (savedForceColor !== undefined) {
      process.env['FORCE_COLOR'] = savedForceColor;
    } else {
      delete process.env['FORCE_COLOR'];
    }
    Object.defineProperty(process.stdout, 'isTTY', { configurable: true, value: undefined });
  });

  it('returns false when NO_COLOR is set regardless of flag', () => {
    process.env['NO_COLOR'] = '';
    setTTY(true, true);
    expect(wantsColor('always')).toBe(false);
  });

  it('returns true when FORCE_COLOR is set regardless of TTY or flag', () => {
    process.env['FORCE_COLOR'] = '1';
    setTTY(false, false);
    expect(wantsColor('never')).toBe(true);
  });

  it('returns false when flag is never and no env override', () => {
    setTTY(true, true);
    expect(wantsColor('never')).toBe(false);
  });

  it('returns true when flag is always and no env override', () => {
    setTTY(false, false);
    expect(wantsColor('always')).toBe(true);
  });

  it('returns true for auto when stdout is a TTY', () => {
    setTTY(true, true);
    expect(wantsColor('auto')).toBe(true);
  });

  it('returns false for auto when stdout is not a TTY', () => {
    setTTY(false, false);
    expect(wantsColor('auto')).toBe(false);
  });

  it('NO_COLOR takes precedence over FORCE_COLOR', () => {
    // Per spec: NO_COLOR wins because it is checked first.
    process.env['NO_COLOR'] = '';
    process.env['FORCE_COLOR'] = '1';
    expect(wantsColor('auto')).toBe(false);
  });
});
