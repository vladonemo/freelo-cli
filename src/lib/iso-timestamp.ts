/**
 * Permissive ISO 8601 / RFC 3339 timestamp parsing for CLI flags (R19.5,
 * spec 0031).
 *
 * Different from the existing `parseDateFlag` helper used by `--due` /
 * `--since` (date-only `YYYY-MM-DD`). This one accepts full timestamps
 * including timezone offsets and bare-date convenience inputs, then
 * canonicalizes everything to second-precision UTC `YYYY-MM-DDTHH:MM:SSZ`
 * so the wire shape is one-and-only-one across all tz inputs.
 *
 * Spec 0031 §2.4 / decision 1.
 */

import { ValidationError } from '../errors/validation-error.js';

/**
 * Maximum allowed delta between `--at` and "now" before we reject as a
 * clock-skew clamp. 60 s comfortably accommodates NTP drift / integration
 * replays without permitting nonsensical futures (decision 2).
 */
export const ISO_TIMESTAMP_FUTURE_SKEW_MS = 60_000;

/**
 * Parse a CLI flag value as a permissive ISO 8601 / RFC 3339 timestamp and
 * canonicalize to UTC `YYYY-MM-DDTHH:MM:SSZ` (second precision, no millis).
 *
 * Accepts any value `Date.parse()` accepts:
 *   - full timestamps with offsets (`2026-04-28T11:00:00+02:00`)
 *   - UTC timestamps (`2026-04-28T09:00:00Z`)
 *   - bare dates (`2026-04-28` → midnight UTC)
 *   - millisecond-precision shapes (`2026-04-28T09:00:00.500Z` → millis stripped)
 *
 * Rejects:
 *   - inputs that don't parse → `ValidationError`
 *   - inputs more than 60 s in the future → `ValidationError`
 *
 * `now` is parameterized for deterministic testing.
 *
 * @param label  Flag name (e.g. `--at`) — used in error messages and hints.
 * @param raw    User-supplied value.
 * @param now    Reference "now" in ms-since-epoch (defaults to `Date.now()`).
 * @returns      Canonical UTC string, e.g. `2026-04-28T09:00:00Z`.
 */
export function parseIsoTimestampFlag(
  label: string,
  raw: string,
  now: number = Date.now(),
): string {
  const t = Date.parse(raw);
  if (Number.isNaN(t)) {
    throw new ValidationError(`${label} must be an ISO 8601 / RFC 3339 timestamp.`, {
      hintNext: `Use ISO 8601 in UTC, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ.`,
    });
  }
  if (t - now > ISO_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new ValidationError(`${label} is in the future.`, {
      hintNext: `Use a UTC ISO 8601 timestamp not in the future, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ. Check your system clock if this looks wrong.`,
    });
  }
  // Canonicalize to second-precision UTC (decision 6).
  const iso = new Date(t).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, 19)}Z`;
}
