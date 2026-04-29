# Resume — 2026-04-29 12:30 (local)

**Paused at:** Phase 2 (Spec binding)
**Question:** Q1 edit verb (PATCH vs POST) + Q2 second-delete idempotency contract.
**Answer:** `A`
**Interpretation:**

- **Q1 → POST.** Spec binds `reports edit` to `POST /work-reports/{work_report_id}` per OpenAPI `yaml:3095`. Roadmap PATCH line is wrong; reconciliation to be done in a separate follow-up doc PR after this slice merges, mirroring R20's reconciliation commit (`f9fe8e8`). Do NOT bundle the roadmap edit into this slice's PR.
- **Q2 → idempotency-via-404-or-content-distinguished-400.** `reports delete` second-delete heuristic:
  - HTTP 404 → `already_in_target_state: true`.
  - HTTP 400 with body matching "not found" / "does not exist" → `already_in_target_state: true`.
  - HTTP 400 with body matching `UserCannotDeleteWorkReport` (or any other ACL-shaped marker) → hard error (auth/ACL stays observable).
  - Any other non-2xx → re-throw as `FreeloApiError`.
  - Mirrors `src/commands/tasks/delete.ts:415-431` precedent. MSW fixtures encode this heuristic; capture a real fixture in a follow-up if the live API ever contradicts.
- **Money helper:** Not needed in this slice. R22 CLI surface in the roadmap exposes `--minutes`, `--note`, `--date` only — no `--cost`. Defer `src/lib/money.ts` to whichever future slice surfaces a cost flag. Log as a decision file after resume.

Resume Phase 2 (architect + freelo-api-specialist write the spec with the bindings above). Then phases 3-6 + PR per the original `/auto` invocation. Yellow tier → PR opens, no auto-merge.
