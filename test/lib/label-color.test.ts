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
 *   - paletteNameForHex / comparePaletteToServer (M05, spec 0067 §4.3):
 *       - case-insensitive in both directions (the wire is lowercase, PALETTE
 *         is uppercase — a case-sensitive compare would report total drift
 *         against a perfectly current server; spec 0067 §3.1(b))
 *       - drift detected in both directions, and neither direction alone
 *       - null/undefined/empty wire values skipped, not crashed on
 *   - paletteHelpBlock:
 *       - contains every palette name and hex value
 *       - is multiline and starts with a blank line
 *       - is deterministic across calls
 */
import { describe, expect, it } from 'vitest';
import {
  PALETTE,
  comparePaletteToServer,
  paletteHelpBlock,
  paletteNameForHex,
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

/* ---------------------------------------------------------------------------
 *  M05 (spec 0067 §4.3) — server-palette comparison helpers.
 *
 *  These never run on the `--palette` resolution path. The tests above for
 *  `resolveColorFlags` / `PALETTE` / `paletteHelpBlock` are unchanged by M05
 *  by design: spec 0067 §6 decided the local table stays authoritative, so a
 *  behaviour change to any of them would be a bug, not a feature.
 * ------------------------------------------------------------------------- */

const ALL_HEXES_UPPER = Object.values(PALETTE) as string[];
const ALL_HEXES_LOWER = ALL_HEXES_UPPER.map((h) => h.toLowerCase());
const ALL_NAMES = Object.keys(PALETTE);

describe('paletteNameForHex', () => {
  it('maps every canonical hex back to its palette name (exact case)', () => {
    for (const name of ALL_NAMES) {
      const hex = (PALETTE as Record<string, string>)[name]!;
      expect(paletteNameForHex(hex)).toBe(name);
    }
  });

  it('is case-insensitive — the wire sends lowercase, PALETTE stores uppercase', () => {
    expect(paletteNameForHex('#15acc0')).toBe('aqua');
    expect(paletteNameForHex('#15ACC0')).toBe('aqua');
    expect(paletteNameForHex('#15AcC0')).toBe('aqua');
  });

  it('returns null for a hex the local table does not know', () => {
    expect(paletteNameForHex('#123456')).toBeNull();
  });

  it('returns null for null, undefined and empty string rather than throwing', () => {
    expect(paletteNameForHex(null)).toBeNull();
    expect(paletteNameForHex(undefined)).toBeNull();
    expect(paletteNameForHex('')).toBeNull();
  });
});

describe('comparePaletteToServer', () => {
  it('reports no drift when the server returns exactly the nine local hexes', () => {
    const cmp = comparePaletteToServer(ALL_HEXES_UPPER);
    expect(cmp.matches).toBe(true);
    expect(cmp.serverOnly).toEqual([]);
    expect(cmp.localOnly).toEqual([]);
  });

  it('still reports no drift when the server sends them lowercase (the real wire case)', () => {
    const cmp = comparePaletteToServer(ALL_HEXES_LOWER);
    expect(cmp.matches).toBe(true);
    expect(cmp.serverOnly).toEqual([]);
    expect(cmp.localOnly).toEqual([]);
  });

  it('reports a server-only hex when the server adds a tenth color', () => {
    const cmp = comparePaletteToServer([...ALL_HEXES_LOWER, '#0abcde']);
    expect(cmp.matches).toBe(false);
    expect(cmp.serverOnly).toEqual(['#0abcde']);
    expect(cmp.localOnly).toEqual([]);
  });

  it('reports a local-only NAME (not hex) when the server drops one', () => {
    const withoutAqua = ALL_HEXES_LOWER.filter((h) => h !== PALETTE.aqua!.toLowerCase());
    const cmp = comparePaletteToServer(withoutAqua);
    expect(cmp.matches).toBe(false);
    expect(cmp.localOnly).toEqual(['aqua']);
    expect(cmp.serverOnly).toEqual([]);
  });

  it('reports drift in both directions at once', () => {
    const swapped = ALL_HEXES_LOWER.filter((h) => h !== PALETTE.red!.toLowerCase());
    const cmp = comparePaletteToServer([...swapped, '#ff0000']);
    expect(cmp.matches).toBe(false);
    expect(cmp.serverOnly).toEqual(['#ff0000']);
    expect(cmp.localOnly).toEqual(['red']);
  });

  it('puts all nine names in localOnly when the server returns nothing', () => {
    const cmp = comparePaletteToServer([]);
    expect(cmp.matches).toBe(false);
    expect(cmp.localOnly).toEqual(ALL_NAMES);
    expect(cmp.serverOnly).toEqual([]);
  });

  it('skips null, undefined and empty entries instead of counting them as drift', () => {
    const cmp = comparePaletteToServer([...ALL_HEXES_LOWER, null, undefined, '']);
    expect(cmp.matches).toBe(true);
    expect(cmp.serverOnly).toEqual([]);
  });

  it('does not report the same unknown hex twice', () => {
    const cmp = comparePaletteToServer([...ALL_HEXES_LOWER, '#0abcde', '#0abcde']);
    expect(cmp.serverOnly).toEqual(['#0abcde']);
  });

  it('preserves PALETTE insertion order in localOnly', () => {
    const cmp = comparePaletteToServer([]);
    expect(cmp.localOnly[0]).toBe('gray');
    expect(cmp.localOnly.at(-1)).toBe('yellow');
  });
});
