# Decision 01 — `reports edit` verb is POST, not PATCH

**Run:** 2026-04-29-1200-r22-reports-write
**Phase:** Spec (Phase 2)
**Agent:** orchestrator (resolving Phase 2 pause via human answer "A")

## Question

Roadmap R22 line says `PATCH /work-reports/{id}`. OpenAPI `docs/api/freelo-api.yaml:3095-3143` documents `POST /work-reports/{work_report_id}`. Which verb does the CLI bind to?

## Decision

**POST.** `reports edit` calls `POST /work-reports/{work_report_id}` per OpenAPI. CLI surface (positional `<id>`, `--minutes`, `--note`, `--date`) stays exactly as the roadmap specified; only the wire verb differs. The roadmap's PATCH typo is reconciled in a **separate follow-up doc PR** after this slice merges — not bundled here. Mirrors the R20 reconciliation pattern (commit `f9fe8e8`).

## Alternatives considered

- **PATCH** — would contradict the documented API. Hard rule "Never invent API behavior" forbids guessing.
- **Pause again to await human edit of `docs/roadmap.md`** — wasteful; roadmap reconciliation is a documentation chore, the runtime contract is unambiguous.

## Rationale

The OpenAPI spec is the binding contract for HTTP behavior (orchestrator hard rule). Two prior R-slices (R18 comments-edit, R20 time-edit) hit the same roadmap-says-PATCH / OpenAPI-says-POST trap and resolved by adopting POST. Human resume answer "A" explicitly affirms POST and defers the roadmap edit to a follow-up.
