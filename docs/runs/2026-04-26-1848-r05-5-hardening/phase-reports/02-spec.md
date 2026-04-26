# Phase 2 — Spec

**Run:** 2026-04-26-1848-r05-5-hardening
**Artifact:** `docs/specs/0015-r05-5-hardening.md`

Three bug sections + plan:
- Bug #1 — relax `UserBasic.fullname`, sweep `WorkerWithHourRate`,
  `HourRate`. Decision: relax these three; defer broader audit.
- Bug #2 — `CurrencySchema.amount` becomes `z.union([string, number])
  .refine(finite).transform(String)`. Decision: normalize to string
  (option (b)) — backwards-compatible, matches existing envelope
  contracts. Documented as a decision-log entry.
- Bug #3 — `dispatcher.destroy()` (forceful) + 250ms timeout race +
  `setImmediate(exit)` defer. Layered defenses; not architectural.
  Regression test is a Windows-matrix subprocess test asserting the
  real condition (no `UV_HANDLE_CLOSING` in stderr) — calibration §1
  trap explicitly addressed.

Plan in §10. Three commits proposed.
