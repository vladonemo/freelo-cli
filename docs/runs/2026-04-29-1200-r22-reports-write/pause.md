## Paused at Phase 2 (Spec binding)

**Run:** 2026-04-29-1200-r22-reports-write
**Reason:** R22 roadmap line names `PATCH /work-reports/{id}` for the edit endpoint, but `docs/api/freelo-api.yaml` (lines 3095-3143) declares the verb as **POST**. The invocation explicitly required pausing — not silently re-routing — when the roadmap contradicts the OpenAPI on this verb. Same trap as R18 (comments edit) and R20 (time edit). Plus a secondary unknown: the OpenAPI does not document second-delete behavior for `DELETE /work-reports/{id}`, which the idempotency contract needs.

**Risk tier:** Yellow (pausing per invocation directive, not per Red trigger).

### What happened

I bootstrapped the run, synced `main` to `7450ab4`, created the run dir, and assigned tier Yellow (additive new commands; one destructive op reusing existing R13/R11 helpers; no auth/HTTP changes). Before invoking architect+freelo-api-specialist for the spec, I bound R22 against `docs/api/freelo-api.yaml`. Two findings hit the invocation's "pause if contradicts roadmap" list:

1. **Verb divergence on edit.** Roadmap: PATCH. OpenAPI yaml :3095 shows `post:` under `/work-reports/{work_report_id}`, with body `{minutes?, cost?, date_reported?, note?, task_id?}` returning 200 `WorkReport`. R18 (`comments edit`) and R20 (`time edit`) hit the same roadmap-PATCH-vs-spec-POST trap and resolved autonomously by adopting POST. The invocation here explicitly forbids that path.

2. **Second-delete behavior undefined.** `DELETE /work-reports/{id}` documents 200 `SuccessResponse` for the success case and notes ACL violations return 400 `UserCannotDeleteWorkReport`. It does **not** document what a second delete returns (404? 400? 200 idempotent?). The idempotency contract for `reports delete` (`already_in_target_state: true`) needs this resolved before I write MSW handlers and test cases.

3. **(Informational, no blocker)** `cost` encoding for log/edit is cents-as-string (e.g. `"100025"` = 1000.25), but the R22 CLI surface does not expose `--cost`, so no `src/lib/money.ts` is needed in this slice. I will log this as a decision after resume — not part of the pause.

### Evidence

- `docs/api/freelo-api.yaml:3095-3143` — `post:` on `/work-reports/{work_report_id}` (edit endpoint).
- `docs/api/freelo-api.yaml:3144-3171` — `delete:` on `/work-reports/{work_report_id}`; only documents the 200 success path.
- `docs/roadmap.md:443` — `**Endpoints:** POST /task/{task_id}/work-reports, PATCH /work-reports/{id}, DELETE /work-reports/{id}.`
- Precedent: `src/commands/time/edit.ts:20-23` — same divergence resolved autonomously in R20 (verb is POST per OpenAPI; decision 8 in spec 0032).
- Precedent: comments edit (R18) — same trap, same resolution.
- Phase report: `docs/runs/2026-04-29-1200-r22-reports-write/phase-reports/02-spec-binding.md`.

### Decision needed

**Two questions, one resume answer.**

**Q1. Edit verb.** The OpenAPI is authoritative per orchestrator hard rules. Confirm the spec should bind to `POST /work-reports/{id}` (matching the OpenAPI and R18/R20 precedent), and that the roadmap line will be reconciled in a follow-up edit (mirroring the R20 reconciliation pattern, see commit f9fe8e8 "docs: reconcile R20 with shipped surface").

**Q2. Second-delete idempotency.** The OpenAPI is silent. Three plausible options:

- **A. Treat 404 (and 400 with body matching `UserCannotDeleteWorkReport`) as `already_in_target_state: true`.** Same heuristic as `tasks delete` (R12). MSW fixture: first DELETE → 200, second → 404 with `{errors: ["..."]}`. Risk: if the server actually returns 200-on-second-delete (truly idempotent), the heuristic is over-broad; we'd incorrectly read a 400 ACL violation as already-deleted on initial calls. Mitigation: the 400 body distinguishes ACL ("UserCannotDeleteWorkReport") from not-found.
- **B. Treat any non-2xx as a hard error (no idempotency).** Loses the agent-safe property. Diverges from `tasks delete` and `comments delete` precedents.
- **C. Defer the idempotency claim — fetch the report first (`GET /work-reports/{id}`-equivalent) to disambiguate before deleting.** No GET-by-id endpoint exists for work reports per OpenAPI; would need a list+filter call, which is expensive and racy. Reject.
- **D. Capture a real fixture via `--allow-network` against a test account before deciding.** Not allowed in this run (`allowNetwork=false`).

Recommend **A** (matches `tasks delete` / `comments delete` precedent, MSW fixtures encode the heuristic; if the live API surprises us, fix in a follow-up). Open to **B** if you want strict semantics for v1 and idempotency added in a follow-up slice once we have a real fixture.

Options:

A. **POST verb + idempotency-via-404-or-ACL-distinguished-400.** Spec binds edit to POST, delete claims `already_in_target_state` on 404 and on 400 with body containing "not found" or "does not exist" (NOT on `UserCannotDeleteWorkReport` 400 — that stays a hard auth-style error). Roadmap reconciliation deferred to a follow-up commit (separate PR, mirrors R20 reconciliation pattern). — clean precedent match, lowest risk.
B. **POST verb + no idempotency for delete (v1).** Spec binds edit to POST. `reports delete` always re-throws non-2xx. Idempotency added in a follow-up slice once we capture a real fixture. — safest behavior, breaks the "every write is idempotent on absorbing state" pattern.
C. **PATCH verb (override OpenAPI).** Sends PATCH and accepts that Freelo may reject it. — never the right answer; rejected.
D. **Abort the run.**

### Resume with

```
/resume 2026-04-29-1200-r22-reports-write A
```

(or `B`, `C`, `D`, or free-form — e.g. `A but mark the 400-pattern match as conservative: only "report not found" or "does not exist", not the broader OR`).
