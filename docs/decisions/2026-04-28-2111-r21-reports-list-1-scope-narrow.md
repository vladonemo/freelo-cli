# Decision 1 — Scope R21 to the global `GET /work-reports` endpoint only

**Run:** 2026-04-28-2111-r21-reports-list
**Phase:** Triage
**Agent:** orchestrator

**Question:** The R21 roadmap line names `GET /task/{task_id}/work-reports` as a second endpoint, but the OpenAPI (`docs/api/freelo-api.yaml`) does not document any GET at that path — only `POST` (used by R22 to create work reports). Do we pause and ask the human, or proceed with the global endpoint?

**Decision:** Proceed against `GET /work-reports` only. Implement `--task <id>` as a wire filter mapping to the documented `?tasks_ids[]=<id>` parameter on the global endpoint. Defer any task-scoped GET to a future R21.5 if the Freelo API surfaces one.

**Alternatives considered:**

- **Pause for human.** Discarded: the documented global endpoint already provides the user-facing functionality the roadmap line specifies (`--task <id>` filter via `tasks_ids[]`). Pausing would block on a question the precedent already answers.
- **Speculatively call `GET /task/{task_id}/work-reports`.** Discarded: explicit hard rule in `.claude/docs/autonomous-sdlc.md` — "API behavior not in `docs/api/freelo-api.yaml` → Pause (don't guess the API)". Calling an undocumented endpoint risks 404s, schema mismatches, or worse, accidentally invoking the POST verb-conflict.
- **Ship without `--task`.** Discarded: the roadmap line lists `--task` first; agents listing one task's time entries is a high-value daily-driver use case. Mapping it to `tasks_ids[]` on the global endpoint preserves the surface.

**Rationale:** R16 (`comments list`) hit the exact same fork — roadmap referenced `GET /task/{task_id}/comments` which wasn't in the OpenAPI, the team narrowed to the global endpoint with a `--task` filter, and the result has been stable in production. R21 follows that precedent. The decision is logged here so the audit trail is explicit, and a future R21.5 can be filed when (if) the Freelo API documents a task-scoped GET.
