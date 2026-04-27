/**
 * Shared idempotency helper for "absorbing-state" write commands.
 *
 * Compares an observed state against a target state and returns whether the
 * caller should skip the write. The helper is **pure** — no I/O — so each
 * resource owns its own GET-the-current-state step (different endpoints,
 * different schemas) and feeds the observed value here.
 *
 * Used by:
 *   - R11 `tasks finish` / `tasks reopen` (states `'finished'` / `'active'`)
 *   - R12 `tasks move` (target tasklist id — different generic param)
 *   - R13 `tasks delete` (state `'deleted'`)
 *   - R14+ `tasks archive`, `tasks mark-read|unread`, label diff helpers
 *
 * Why a helper at all if it's a two-line equality? Three reasons:
 *   1. The call site reads as a **single semantic step** rather than a
 *      comparison embedded in business logic.
 *   2. The `equivalents` knob lets archive (R14) treat both `'archived'` and
 *      `'archived_finished'` as "already-in-target" without re-implementing
 *      the predicate per-resource.
 *   3. The `IdempotencyCheck<S>` return type IS the public envelope contract
 *      — adding a field here ripples through every consumer in a typed way
 *      (Calibration §4 — easier to review the diff than chase comparisons
 *      across leaf commands).
 *
 * Spec 0021 §3.3.
 */

export type IdempotencyCheck<S extends string = string> = {
  /**
   * `true` when the caller should NOT issue the write — the observed state
   * already satisfies the target. `false` means proceed with the POST.
   */
  alreadyInTargetState: boolean;
  observedState: S;
  targetState: S;
};

export type CheckIdempotencyOptions<S extends string> = {
  observedState: S;
  targetState: S;
  /**
   * Optional equivalence set — observed states that count as already-in-target.
   * The target itself is implicitly included; callers do not need to pass it.
   *
   * Example (archive — R14): `equivalents: new Set(['archived', 'archived_finished'])`
   * with `targetState: 'archived'`. An observed `'archived_finished'` would
   * still report `alreadyInTargetState: true`.
   */
  equivalents?: ReadonlySet<S>;
};

/**
 * Pure predicate: is the observed state already satisfying the target?
 *
 * Default semantics (no `equivalents`): identity. `observedState === targetState`
 * ⇔ `alreadyInTargetState: true`.
 *
 * With `equivalents`: the observed state counts as already-in-target if it
 * equals the target OR is in the equivalents set. The target is treated as a
 * member of the set even when not explicitly listed.
 */
export function checkIdempotency<S extends string>(
  opts: CheckIdempotencyOptions<S>,
): IdempotencyCheck<S> {
  const { observedState, targetState, equivalents } = opts;
  const alreadyInTargetState =
    observedState === targetState || (equivalents !== undefined && equivalents.has(observedState));
  return {
    alreadyInTargetState,
    observedState,
    targetState,
  };
}
