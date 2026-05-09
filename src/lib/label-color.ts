/**
 * Single source of truth for Freelo's nine-name label color palette (R24.5,
 * spec 0048).
 *
 * Freelo's label palette is fixed at nine canonical hues. Hex values outside
 * the palette are silently snapped on the server, so the CLI surfaces the
 * palette by name (`--palette <name>`) on every command that today accepts
 * `--hex`. Both flags terminate in the same wire field — `color: "#RRGGBB"`.
 *
 * `--palette` and `--hex` are mutually exclusive on every consumer; resolution
 * happens here so the per-command files only see a single resolved hex (or
 * `undefined`).
 *
 * Insertion order in `PALETTE` matches the requirement table (gray → yellow);
 * `Object.freeze` preserves it for deterministic help output.
 */
import { ValidationError } from '../errors/validation-error.js';

export const PALETTE: Readonly<Record<string, `#${string}`>> = Object.freeze({
  gray: '#77787A',
  aqua: '#15ACC0',
  blue: '#367FEE',
  green: '#10AA40',
  pink: '#CA3E99',
  purple: '#9235E4',
  red: '#E9483A',
  orange: '#F2830B',
  yellow: '#E3B51E',
});

export type PaletteName = keyof typeof PALETTE;

const NAMES: readonly string[] = Object.keys(PALETTE);

function nameList(): string {
  return NAMES.join(', ');
}

export interface ResolveColorFlagsInput {
  readonly palette?: string | undefined;
  readonly hex?: string | undefined;
}

/**
 * Resolves `--palette` / `--hex` to a single wire `color` value or undefined.
 *
 * - Throws `ValidationError` (exit 2) if both flags are set (mutex).
 * - Throws `ValidationError` if `--palette` is set but does not match a
 *   palette name (case-insensitive).
 * - Returns the resolved hex when `--palette` is set.
 * - Returns `--hex` unchanged when only it is set; `--hex` shape validation
 *   stays in the per-command Commander parser (`parseHexColorFlag`).
 * - Returns `undefined` when neither flag is set.
 */
export function resolveColorFlags(input: ResolveColorFlagsInput): string | undefined {
  if (input.palette !== undefined && input.hex !== undefined) {
    throw new ValidationError('--palette and --hex are mutually exclusive.', {
      hintNext: `Pick one. Palette names: ${nameList()}.`,
    });
  }

  if (input.palette !== undefined) {
    const key = input.palette.toLowerCase();
    const hex = (PALETTE as Record<string, `#${string}`>)[key];
    if (hex === undefined) {
      throw new ValidationError(
        `--palette ${JSON.stringify(input.palette)} is not a recognized palette name.`,
        {
          hintNext: `Use one of: ${nameList()}.`,
        },
      );
    }
    return hex;
  }

  return input.hex;
}

/**
 * Returns a multiline, Commander-friendly help block listing the nine palette
 * entries with their hex values. Used by the affected commands via
 * `.addHelpText('after', paletteHelpBlock())` so `--help` shows the table
 * inline.
 *
 * Determinism: insertion order of `PALETTE` (frozen object) matches the
 * requirement table. The block leads with a blank line so Commander renders
 * it as its own paragraph below the options list.
 */
export function paletteHelpBlock(): string {
  const maxName = NAMES.reduce((acc, n) => Math.max(acc, n.length), 0);
  const rows = NAMES.map((name) => {
    const hex = (PALETTE as Record<string, string>)[name]!;
    return `  ${name.padEnd(maxName)}  ${hex}`;
  });
  return ['', 'Palette names accepted by --palette (case-insensitive):', ...rows].join('\n');
}
