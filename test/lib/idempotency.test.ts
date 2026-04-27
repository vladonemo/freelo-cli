/**
 * Unit tests for `src/lib/idempotency.ts` (R11 spec 0021 §3.3).
 *
 * Pure predicate; no I/O. Covers:
 *   - identity: observed === target → alreadyInTargetState true
 *   - mismatch: observed !== target → false
 *   - equivalents: a third state in the set narrows to true
 *   - mismatch outside equivalents: false even with a non-empty set
 *   - the returned object echoes the inputs (typed contract)
 *
 * Calibration §2: this helper drives a public envelope field
 * (`already_in_target_state`); every branch needs a test row.
 */

import { describe, expect, it } from 'vitest';
import { checkIdempotency } from '../../src/lib/idempotency.js';

describe('checkIdempotency', () => {
  it('returns alreadyInTargetState: true on identity (observed === target)', () => {
    const r = checkIdempotency({ observedState: 'finished', targetState: 'finished' });
    expect(r.alreadyInTargetState).toBe(true);
    expect(r.observedState).toBe('finished');
    expect(r.targetState).toBe('finished');
  });

  it('returns alreadyInTargetState: false on mismatch (no equivalents)', () => {
    const r = checkIdempotency({ observedState: 'active', targetState: 'finished' });
    expect(r.alreadyInTargetState).toBe(false);
    expect(r.observedState).toBe('active');
    expect(r.targetState).toBe('finished');
  });

  it('returns true when observed is in the equivalents set', () => {
    // Archive (R14) preview: both 'archived' and 'archived_finished' should
    // count as already-archived.
    const r = checkIdempotency<'active' | 'archived' | 'archived_finished'>({
      observedState: 'archived_finished',
      targetState: 'archived',
      equivalents: new Set(['archived_finished']),
    });
    expect(r.alreadyInTargetState).toBe(true);
    expect(r.observedState).toBe('archived_finished');
    expect(r.targetState).toBe('archived');
  });

  it('returns false when observed is NOT in the equivalents set and not the target', () => {
    const r = checkIdempotency<'active' | 'archived' | 'archived_finished'>({
      observedState: 'active',
      targetState: 'archived',
      equivalents: new Set(['archived_finished']),
    });
    expect(r.alreadyInTargetState).toBe(false);
  });

  it('still returns true on identity even when equivalents is supplied', () => {
    const r = checkIdempotency<'active' | 'archived'>({
      observedState: 'archived',
      targetState: 'archived',
      equivalents: new Set(['archived']),
    });
    expect(r.alreadyInTargetState).toBe(true);
  });

  it('preserves the generic state-string parameter (type-level contract)', () => {
    type S = 'a' | 'b' | 'c';
    const r = checkIdempotency<S>({ observedState: 'a', targetState: 'b' });
    // Compile-time: r.observedState/targetState narrow to S.
    const observed: S = r.observedState;
    const target: S = r.targetState;
    expect(observed).toBe('a');
    expect(target).toBe('b');
    expect(r.alreadyInTargetState).toBe(false);
  });
});
