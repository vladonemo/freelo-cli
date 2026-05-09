/**
 * Unit tests for src/lib/label-color.ts (R24.5, spec 0048).
 *
 * Covers:
 *   - PALETTE constant: shape (nine entries, all `#RRGGBB`).
 *   - resolveColorFlags:
 *       - returns undefined when neither flag is set
 *       - returns --hex unchanged when only --hex is set (no shape re-validation)
 *       - resolves every palette name to its canonical hex (parametrized × 9)
 *       - case-insensitive lookup (RED, Red, red → same hex)
 *       - mutex: both flags set → ValidationError, exit 2, hintNext lists names
 *       - unknown name → ValidationError, exit 2, hintNext enumerates names
 *       - empty string for --palette → unknown-name path (ValidationError)
 *   - paletteHelpBlock:
 *       - contains every palette name and hex value
 *       - is multiline and starts with a blank line
 *       - is deterministic across calls
 */
import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  paletteHelpBlock,
  resolveColorFlags,
  type PaletteName,
} from '../../src/lib/label-color.js';
import { ValidationError } from '../../src/errors/validation-error.js';

const HEX_PATTERN = /^#[0-9A-F]{6}$/;

describe('PALETTE constant', () => {
  it('has exactly nine entries', () => {
    expect(Object.keys(PALETTE)).toHaveLength(9);
  });

  it('every entry matches /^#[0-9A-F]{6}$/', () => {
    for (const [name, hex] of Object.entries(PALETTE)) {
      expect(hex, `palette[${name}] = ${hex}`).toMatch(HEX_PATTERN);
    }
  });

  it('preserves requirement insertion order', () => {
    expect(Object.keys(PALETTE)).toEqual([
      'gray',
      'aqua',
      'blue',
      'green',
      'pink',
      'purple',
      'red',
      'orange',
      'yellow',
    ]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(PALETTE)).toBe(true);
  });
});

describe('resolveColorFlags — happy paths', () => {
  it('returns undefined when neither flag is set', () => {
    expect(resolveColorFlags({})).toBeUndefined();
  });

  it('returns --hex unchanged when only --hex is set', () => {
    expect(resolveColorFlags({ hex: '#abcdef' })).toBe('#abcdef');
  });

  it('does not re-validate --hex shape (helper trusts the Commander parser)', () => {
    // Garbage in, garbage out — shape validation lives in parseHexColorFlag,
    // not here. This documents the contract.
    expect(resolveColorFlags({ hex: 'not-a-hex' })).toBe('not-a-hex');
  });

  const paletteCases: ReadonlyArray<readonly [PaletteName, string]> = [
    ['gray', '#77787A'],
    ['aqua', '#15ACC0'],
    ['blue', '#367FEE'],
    ['green', '#10AA40'],
    ['pink', '#CA3E99'],
    ['purple', '#9235E4'],
    ['red', '#E9483A'],
    ['orange', '#F2830B'],
    ['yellow', '#E3B51E'],
  ];
  it.each(paletteCases)('resolves --palette %s → %s', (name, hex) => {
    expect(resolveColorFlags({ palette: name })).toBe(hex);
  });

  it('--palette is case-insensitive (RED / Red / red all resolve to the same hex)', () => {
    expect(resolveColorFlags({ palette: 'RED' })).toBe('#E9483A');
    expect(resolveColorFlags({ palette: 'Red' })).toBe('#E9483A');
    expect(resolveColorFlags({ palette: 'rEd' })).toBe('#E9483A');
    expect(resolveColorFlags({ palette: 'red' })).toBe('#E9483A');
  });
});

describe('resolveColorFlags — error paths (Calibration §2: exit-code asserts)', () => {
  it('mutex: --palette + --hex → ValidationError (exit 2), hintNext lists names', () => {
    let caught: unknown;
    try {
      resolveColorFlags({ palette: 'red', hex: '#000000' });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const e = caught as ValidationError;
    expect(e.exitCode).toBe(2);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.message).toMatch(/mutually exclusive/);
    expect(e.hintNext).toMatch(/gray.*aqua.*blue.*green.*pink.*purple.*red.*orange.*yellow/);
  });

  it('unknown palette name → ValidationError (exit 2), hintNext enumerates the nine', () => {
    let caught: unknown;
    try {
      resolveColorFlags({ palette: 'turquoise' });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    const e = caught as ValidationError;
    expect(e.exitCode).toBe(2);
    expect(e.code).toBe('VALIDATION_ERROR');
    expect(e.message).toMatch(/turquoise/);
    expect(e.message).toMatch(/not a recognized palette name/);
    expect(e.hintNext).toMatch(/gray.*aqua.*blue.*green.*pink.*purple.*red.*orange.*yellow/);
  });

  it('empty-string --palette is treated as an unknown name', () => {
    expect(() => resolveColorFlags({ palette: '' })).toThrow(ValidationError);
  });

  it('unknown name even when --hex is also empty-string still triggers mutex first', () => {
    // Defensive: explicit-undefined is the only "absent" sentinel. Empty string
    // means the flag was passed.
    let caught: unknown;
    try {
      resolveColorFlags({ palette: '', hex: '#000000' });
    } catch (err: unknown) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ValidationError);
    expect((caught as ValidationError).message).toMatch(/mutually exclusive/);
  });
});

describe('paletteHelpBlock', () => {
  it('contains every palette name', () => {
    const block = paletteHelpBlock();
    for (const name of Object.keys(PALETTE)) {
      expect(block, `block missing name: ${name}`).toContain(name);
    }
  });

  it('contains every palette hex value', () => {
    const block = paletteHelpBlock();
    for (const hex of Object.values(PALETTE)) {
      expect(block, `block missing hex: ${hex}`).toContain(hex);
    }
  });

  it('is multiline and leads with a blank line', () => {
    const block = paletteHelpBlock();
    expect(block.split('\n').length).toBeGreaterThan(1);
    expect(block.startsWith('\n')).toBe(true);
  });

  it('is deterministic across calls', () => {
    expect(paletteHelpBlock()).toBe(paletteHelpBlock());
  });

  it('mentions case-insensitivity (so --help users see the contract)', () => {
    expect(paletteHelpBlock()).toMatch(/case-insensitive/i);
  });
});
