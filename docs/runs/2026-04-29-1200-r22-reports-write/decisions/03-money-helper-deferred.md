# Decision 03 — Money helper deferred (no `--cost` in R22)

**Run:** 2026-04-29-1200-r22-reports-write
**Phase:** Spec (Phase 2)
**Agent:** orchestrator

## Question

The roadmap R22 line says: "Ships with this slice: currency/money helper if the backend asks for rate-in-cents on this endpoint." Do we ship `src/lib/money.ts` in this slice?

## Decision

**No.** The R22 CLI surface (per the roadmap's own command block) exposes only `--minutes`, `--note`, `--date`. There is no `--cost` flag. The OpenAPI body field `cost` (string, cents-as-int-stringified, e.g. `"100025"` = 1000.25) is therefore never set by R22's command surface — the server derives it from the worker's hourly rate × minutes, which is the documented default.

Defer `src/lib/money.ts` to whichever future slice surfaces a `--cost` flag (likely a follow-up to R22 or part of the invoicing slices). Response-side `cost` already round-trips via the existing `CurrencySchema` in `src/api/schemas/report.ts` (R21).

## Alternatives considered

- **Add `src/lib/money.ts` now and an `--cost` flag.** Out of scope for R22 per roadmap CLI block. Would expand the diff and add a flag the spec doesn't require.
- **Add the helper without a flag, "for the future".** Dead code; violates conventions doc. Ship it when the consumer ships.

## Rationale

The roadmap's "ships with this slice" clause is conditional ("if the backend asks for rate-in-cents on this endpoint"). The backend asks for cents only when the user explicitly sets `cost`. R22's CLI doesn't offer that knob, so the helper isn't load-bearing yet. Punting keeps the slice narrow.
