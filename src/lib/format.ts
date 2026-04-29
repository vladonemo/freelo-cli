/**
 * Pure formatting helpers shared across renderers.
 *
 * Originally extracted from `src/ui/human/files-list.ts` (R26) when R27
 * (`files download`) became the third caller for `humanizeBytes`. Spec 0039
 * decision 04.
 */

/**
 * Format a non-negative byte count as a human-readable string with one
 * decimal of precision: `<1 KB`, `<1 MB`, `<1 GB`, otherwise `GB`.
 *
 * Decimal SI multipliers (1 KB = 1024 B) — matches what most desktop OS
 * file managers display when showing file sizes.
 *
 * Inputs that are not finite non-negative numbers are clamped to `0`.
 */
export function humanizeBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '0 B';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
