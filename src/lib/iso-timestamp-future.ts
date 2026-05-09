/**
 * Future-direction ISO 8601 / RFC 3339 timestamp parsing for CLI flags.
 *
 * Sibling of `parseIsoTimestampFlag` (R19.5, spec 0031). Same RFC 3339 / ISO
 * 8601 acceptance + canonicalization to second-precision UTC
 * `YYYY-MM-DDTHH:MM:SSZ`. The only difference is the clock-skew clamp
 * direction:
 *   - `parseIsoTimestampFlag` rejects values >60 s in the future (backdating).
 *   - `parseIsoTimestampFutureFlag` rejects values >60 s in the past (reminders).
 *
 * R35 (`tasks remind set --at <ISO>`, spec 0049 §3.5 / decision 1-2). Reuses
 * the `ISO_TIMESTAMP_FUTURE_SKEW_MS` constant from the sibling helper so the
 * tolerance window is symmetric (60 s either side of "now") across both.
 */

import { ValidationError } from '../errors/validation-error.js';
import { ISO_TIMESTAMP_FUTURE_SKEW_MS } from './iso-timestamp.js';

/**
 * Parse a CLI flag value as a permissive ISO 8601 / RFC 3339 timestamp and
 * canonicalize to UTC `YYYY-MM-DDTHH:MM:SSZ` (second precision, no millis).
 *
 * Accepts any value `Date.parse()` accepts:
 *   - full timestamps with offsets (`2099-01-01T11:00:00+02:00`)
 *   - UTC timestamps (`2099-01-01T09:00:00Z`)
 *   - bare dates (`2099-01-01` → midnight UTC)
 *   - millisecond-precision shapes (`2099-01-01T09:00:00.500Z` → millis stripped)
 *
 * Rejects:
 *   - inputs that don't parse → `ValidationError`
 *   - inputs more than 60 s in the **past** → `ValidationError` (clock-skew clamp)
 *
 * `now` is parameterized for deterministic testing.
 *
 * @param label  Flag name (e.g. `--at`) — used in error messages and hints.
 * @param raw    User-supplied value.
 * @param now    Reference "now" in ms-since-epoch (defaults to `Date.now()`).
 * @returns      Canonical UTC string, e.g. `2099-01-01T09:00:00Z`.
 */
export function parseIsoTimestampFutureFlag(
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
  if (now - t > ISO_TIMESTAMP_FUTURE_SKEW_MS) {
    throw new ValidationError(`${label} is in the past.`, {
      hintNext: `Use a UTC ISO 8601 timestamp in the future, e.g. ${label} YYYY-MM-DDTHH:MM:SSZ. Reminders only make sense for upcoming instants.`,
    });
  }
  // Canonicalize to second-precision UTC (mirrors `parseIsoTimestampFlag`).
  const iso = new Date(t).toISOString(); // YYYY-MM-DDTHH:MM:SS.mmmZ
  return `${iso.slice(0, 19)}Z`;
}
