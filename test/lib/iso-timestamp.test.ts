/**
 * Unit tests for `parseIsoTimestampFlag` (R19.5, spec 0031 §3.1).
 *
 * Concerns:
 *   - Acceptance shapes: full UTC, tz-offset, bare date, milliseconds.
 *   - Canonicalization: tz normalized to UTC, millis stripped.
 *   - Rejections: malformed input, empty string, future > 60 s skew.
 *   - Error contract: `ValidationError` (BaseError, exit 2) with helpful hints.
 *   - Deterministic-now parameter for reproducible future-clamp tests.
 *   - Custom label propagation.
 *
 * Calibration §2 — every error-class path has an explicit `exitCode` assertion.
 */

import { describe, expect, it } from 'vitest';
import {
  ISO_TIMESTAMP_FUTURE_SKEW_MS,
  parseIsoTimestampFlag,
} from '../../src/lib/iso-timestamp.js';
import { ValidationError } from '../../src/errors/validation-error.js';

const FIXED_NOW = Date.parse('2026-04-28T12:00:00Z');

describe('parseIsoTimestampFlag — acceptance shapes', () => {
  it('accepts a full UTC ISO 8601 timestamp and returns it canonicalized', () => {
    const out = parseIsoTimestampFlag('--at', '2026-04-28T09:00:00Z', FIXED_NOW);
    expect(out).toBe('2026-04-28T09:00:00Z');
  });

  it('accepts a tz-offset timestamp and normalizes to UTC', () => {
    const out = parseIsoTimestampFlag('--at', '2026-04-28T11:00:00+02:00', FIXED_NOW);
    expect(out).toBe('2026-04-28T09:00:00Z');
  });

  it('accepts a negative-offset timestamp and normalizes to UTC', () => {
    const out = parseIsoTimestampFlag('--at', '2026-04-28T05:00:00-04:00', FIXED_NOW);
    expect(out).toBe('2026-04-28T09:00:00Z');
  });

  it('accepts a bare date (YYYY-MM-DD) as midnight UTC', () => {
    const out = parseIsoTimestampFlag('--at', '2026-04-28', FIXED_NOW);
    expect(out).toBe('2026-04-28T00:00:00Z');
  });

  it('strips millisecond precision (decision 6)', () => {
    const out = parseIsoTimestampFlag('--at', '2026-04-28T09:00:00.500Z', FIXED_NOW);
    expect(out).toBe('2026-04-28T09:00:00Z');
  });

  it('accepts an instant exactly 60 s in the future (boundary inclusive)', () => {
    const at = new Date(FIXED_NOW + ISO_TIMESTAMP_FUTURE_SKEW_MS).toISOString();
    const out = parseIsoTimestampFlag('--at', at, FIXED_NOW);
    // Canonical second-precision representation of FIXED_NOW + 60 s.
    expect(out).toBe('2026-04-28T12:01:00Z');
  });

  it('accepts a far-past timestamp without a client-side bound (decision 3)', () => {
    const out = parseIsoTimestampFlag('--at', '1970-01-01T00:00:00Z', FIXED_NOW);
    expect(out).toBe('1970-01-01T00:00:00Z');
  });
});

describe('parseIsoTimestampFlag — rejection paths', () => {
  it('throws ValidationError on a non-date string', () => {
    expect(() => parseIsoTimestampFlag('--at', 'not a date', FIXED_NOW)).toThrowError(
      ValidationError,
    );
  });

  it('throws ValidationError on an empty string', () => {
    expect(() => parseIsoTimestampFlag('--at', '', FIXED_NOW)).toThrowError(ValidationError);
  });

  it('the malformed-input ValidationError carries exit 2 and an actionable hint', () => {
    try {
      parseIsoTimestampFlag('--at', 'gibberish', FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.exitCode).toBe(2);
      expect(ve.code).toBe('VALIDATION_ERROR');
      expect(ve.message).toContain('--at must be');
      // Hint guides the user to the correct shape.
      expect(ve.hintNext).toContain('--at YYYY-MM-DDTHH:MM:SSZ');
    }
  });

  it('throws ValidationError when the timestamp is more than 60 s in the future', () => {
    const at = new Date(FIXED_NOW + ISO_TIMESTAMP_FUTURE_SKEW_MS + 1_000).toISOString();
    expect(() => parseIsoTimestampFlag('--at', at, FIXED_NOW)).toThrowError(ValidationError);
  });

  it('the future-skew ValidationError carries exit 2 and a clock-skew hint', () => {
    const at = new Date(FIXED_NOW + ISO_TIMESTAMP_FUTURE_SKEW_MS + 5_000).toISOString();
    try {
      parseIsoTimestampFlag('--at', at, FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      const ve = err as ValidationError;
      expect(ve.exitCode).toBe(2);
      expect(ve.message).toContain('--at is in the future');
      expect(ve.hintNext).toContain('Check your system clock');
    }
  });

  it('rejects a far-future timestamp like 2099 against any reasonable now', () => {
    expect(() => parseIsoTimestampFlag('--at', '2099-01-01T00:00:00Z', FIXED_NOW)).toThrowError(
      ValidationError,
    );
  });
});

describe('parseIsoTimestampFlag — label propagation', () => {
  it('uses the supplied label in error messages', () => {
    try {
      parseIsoTimestampFlag('--start', 'nope', FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.message).toContain('--start must be');
      expect(ve.hintNext).toContain('--start YYYY-MM-DDTHH:MM:SSZ');
    }
  });

  it('uses the supplied label in the future-skew error too', () => {
    const at = new Date(FIXED_NOW + 10 * 60_000).toISOString();
    try {
      parseIsoTimestampFlag('--start', at, FIXED_NOW);
      throw new Error('should have thrown');
    } catch (err) {
      const ve = err as ValidationError;
      expect(ve.message).toContain('--start is in the future');
      expect(ve.hintNext).toContain('--start YYYY-MM-DDTHH:MM:SSZ');
    }
  });
});

describe('parseIsoTimestampFlag — defaults', () => {
  it('defaults `now` to Date.now() when not supplied (smoke test)', () => {
    // 5 minutes ago — must always be valid regardless of when the test runs.
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    const out = parseIsoTimestampFlag('--at', fiveMinutesAgo);
    // Round-trip-safe — canonical output matches the canonical input minus millis.
    expect(out).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
  });
});
