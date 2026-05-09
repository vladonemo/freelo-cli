/**
 * Unit tests for `parseIsoTimestampFutureFlag` (R35, spec 0049 §3.5).
 *
 * Sibling helper to `parseIsoTimestampFlag` (R19.5). Same canonicalization;
 * inverted clock-skew clamp (rejects past >60 s; futures are accepted).
 *
 * Concerns:
 *   - Acceptance shapes: full UTC (future), tz-offset, bare date, milliseconds.
 *   - Canonicalization: tz normalized to UTC, millis stripped.
 *   - Rejections: malformed input, empty string, past > 60 s skew.
 *   - Error contract: `ValidationError` (BaseError, exit 2) with helpful hints.
 *   - Deterministic-now parameter for reproducible past-clamp tests.
 *   - Custom label propagation.
 *
 * Calibration §2 — every error-class path has an explicit `exitCode` assertion.
 */

import { describe, expect, it } from 'vitest';
import { ISO_TIMESTAMP_FUTURE_SKEW_MS } from '../../src/lib/iso-timestamp.js';
import { parseIsoTimestampFutureFlag } from '../../src/lib/iso-timestamp-future.js';
import { ValidationError } from '../../src/errors/validation-error.js';

const FIXED_NOW = Date.parse('2026-05-09T12:00:00Z');

describe('parseIsoTimestampFutureFlag — acceptance shapes', () => {
  it('accepts a future UTC ISO 8601 timestamp and returns it canonicalized', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-01-01T09:00:00Z', FIXED_NOW);
    expect(out).toBe('2099-01-01T09:00:00Z');
  });

  it('accepts a tz-offset future timestamp and normalizes to UTC', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-01-01T11:00:00+02:00', FIXED_NOW);
    expect(out).toBe('2099-01-01T09:00:00Z');
  });

  it('accepts a negative-offset future timestamp and normalizes to UTC', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-01-01T05:00:00-04:00', FIXED_NOW);
    expect(out).toBe('2099-01-01T09:00:00Z');
  });

  it('accepts a bare date (YYYY-MM-DD) in the future as midnight UTC', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-04-28', FIXED_NOW);
    expect(out).toBe('2099-04-28T00:00:00Z');
  });

  it('strips millisecond precision', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-01-01T09:00:00.500Z', FIXED_NOW);
    expect(out).toBe('2099-01-01T09:00:00Z');
  });

  it('accepts an instant exactly 60 s in the past (boundary inclusive)', () => {
    const at = new Date(FIXED_NOW - ISO_TIMESTAMP_FUTURE_SKEW_MS).toISOString();
    const out = parseIsoTimestampFutureFlag('--at', at, FIXED_NOW);
    expect(out).toBe('2026-05-09T11:59:00Z');
  });

  it('accepts an instant exactly at "now" (within 60 s tolerance)', () => {
    const at = new Date(FIXED_NOW).toISOString();
    const out = parseIsoTimestampFutureFlag('--at', at, FIXED_NOW);
    expect(out).toBe('2026-05-09T12:00:00Z');
  });

  it('accepts a far-future timestamp without an upper bound', () => {
    const out = parseIsoTimestampFutureFlag('--at', '2099-12-31T23:59:59Z', FIXED_NOW);
    expect(out).toBe('2099-12-31T23:59:59Z');
  });
});

describe('parseIsoTimestampFutureFlag — rejection paths', () => {
  it('throws ValidationError on a non-date string', () => {
    expect(() => parseIsoTimestampFutureFlag('--at', 'not a date', FIXED_NOW)).toThrowError(
      ValidationError,
    );
  });

  it('throws ValidationError on an empty string', () => {
    expect(() => parseIsoTimestampFutureFlag('--at', '', FIXED_NOW)).toThrowError(ValidationError);
  });

  it('the malformed-input ValidationError carries exit 2 and an actionable hint', () => {
    try {
      parseIsoTimestampFutureFlag('--at', 'gibberish', FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.exitCode).toBe(2);
      expect(ve.code).toBe('VALIDATION_ERROR');
      expect(ve.message).toContain('--at must be');
      expect(ve.hintNext).toContain('--at YYYY-MM-DDTHH:MM:SSZ');
    }
  });

  it('throws ValidationError when the timestamp is more than 60 s in the past', () => {
    const at = new Date(FIXED_NOW - ISO_TIMESTAMP_FUTURE_SKEW_MS - 1_000).toISOString();
    expect(() => parseIsoTimestampFutureFlag('--at', at, FIXED_NOW)).toThrowError(ValidationError);
  });

  it('the past-skew ValidationError carries exit 2 and a future-time hint', () => {
    const at = new Date(FIXED_NOW - ISO_TIMESTAMP_FUTURE_SKEW_MS - 5_000).toISOString();
    try {
      parseIsoTimestampFutureFlag('--at', at, FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.exitCode).toBe(2);
      expect(ve.message).toContain('--at is in the past');
      expect(ve.hintNext).toContain('Reminders only make sense for upcoming instants');
    }
  });

  it('rejects a far-past timestamp like 1970 against any reasonable now', () => {
    expect(() =>
      parseIsoTimestampFutureFlag('--at', '1970-01-01T00:00:00Z', FIXED_NOW),
    ).toThrowError(ValidationError);
  });
});

describe('parseIsoTimestampFutureFlag — label propagation', () => {
  it('uses the supplied label in error messages', () => {
    try {
      parseIsoTimestampFutureFlag('--remind-at', 'nope', FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.message).toContain('--remind-at must be');
      expect(ve.hintNext).toContain('--remind-at YYYY-MM-DDTHH:MM:SSZ');
    }
  });

  it('uses the supplied label in the past-skew error too', () => {
    const at = new Date(FIXED_NOW - 10 * 60_000).toISOString();
    try {
      parseIsoTimestampFutureFlag('--remind-at', at, FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.message).toContain('--remind-at is in the past');
      expect(ve.hintNext).toContain('--remind-at YYYY-MM-DDTHH:MM:SSZ');
    }
  });
});

describe('parseIsoTimestampFutureFlag — defaults', () => {
  it('defaults `now` to Date.now() when not supplied (smoke test)', () => {
    // 1 hour from now — always future regardless of when the test runs.
    const inOneHour = new Date(Date.now() + 60 * 60_000).toISOString();
    const out = parseIsoTimestampFutureFlag('--at', inOneHour);
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
