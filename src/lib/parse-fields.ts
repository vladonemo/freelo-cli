/**
 * Parse a `--fields a,b,c` flag value into a `string[]`.
 *
 * - Trims surrounding whitespace on each token.
 * - Drops empty tokens (so `a,,b` → `['a', 'b']`).
 * - Returns the array as-is — validation against the known-fields registry
 *   happens in `projectFields` (src/api/pagination.ts) so the same error
 *   path serves both the fields-validation pass and field projection.
 *
 * This helper does NOT throw on an empty result — that's `projectFields`'
 * job (it owns the EMPTY_FIELDS error so the message stays consistent).
 */
export function parseFieldsFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
