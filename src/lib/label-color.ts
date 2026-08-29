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

/* ---------------------------------------------------------------------------
 *  Server-palette comparison helpers (M05, spec 0067 §4.3)
 *
 *  These read `PALETTE`; they never mutate it and are never on the
 *  `--palette` resolution path. `resolveColorFlags` stays offline, pure and
 *  synchronous — spec 0067 §6 explains why that is deliberate and not an
 *  oversight.
 *
 *  Every comparison is case-insensitive: the wire uses lowercase hex
 *  ("#15acc0", yaml :5964) and `PALETTE` stores uppercase ("#15ACC0"), so a
 *  case-sensitive compare would report total drift against a perfectly
 *  current server. Spec 0067 §3.1(b).
 * ------------------------------------------------------------------------- */

/** Lowercased hex → palette name, built once from the frozen `PALETTE`. */
const HEX_TO_NAME: ReadonlyMap<string, string> = new Map(
  NAMES.map((name) => [(PALETTE as Record<string, string>)[name]!.toLowerCase(), name]),
);

/**
 * The local `--palette` name for a hex value, or `null` when the hex is not in
 * the local table. Case-insensitive; `null`/`undefined`/empty input yields
 * `null` rather than throwing — the caller is mapping a permissive wire value.
 */
export function paletteNameForHex(hex: string | null | undefined): string | null {
  if (hex === null || hex === undefined || hex === '') return null;
  return HEX_TO_NAME.get(hex.toLowerCase()) ?? null;
}

export interface PaletteComparison {
  /** True when neither side has an entry the other lacks. */
  readonly matches: boolean;
  /** Server hex values with no local palette name (reachable only via `--hex`). */
  readonly serverOnly: string[];
  /** Local palette names whose hex the server did not return. */
  readonly localOnly: string[];
}

/**
 * Compare the server's accepted palette against the local `PALETTE`.
 *
 * `serverOnly` carries hex values (there is no local name for them, by
 * definition); `localOnly` carries names (that is what a user types into
 * `--palette`). Null/undefined/empty server entries are skipped, not counted
 * as drift — the inbound schema is permissive by policy and a missing `color`
 * is a server bug, not a palette change.
 *
 * Order is deterministic: `serverOnly` follows the server's response order,
 * `localOnly` follows `PALETTE`'s frozen insertion order.
 */
export function comparePaletteToServer(
  serverColors: readonly (string | null | undefined)[],
): PaletteComparison {
  const seen = new Set<string>();
  const serverOnly: string[] = [];

  for (const raw of serverColors) {
    if (raw === null || raw === undefined || raw === '') continue;
    const lower = raw.toLowerCase();
    seen.add(lower);
    if (!HEX_TO_NAME.has(lower) && !serverOnly.includes(raw)) serverOnly.push(raw);
  }

  const localOnly = NAMES.filter(
    (name) => !seen.has((PALETTE as Record<string, string>)[name]!.toLowerCase()),
  );

  return {
    matches: serverOnly.length === 0 && localOnly.length === 0,
    serverOnly,
    localOnly,
  };
}
