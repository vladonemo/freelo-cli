# Decision 1 — `--with projects` data source

**Run:** 2026-04-27-0535-tasks-show
**Phase:** spec / plan
**Agent:** orchestrator (acting on architect role + freelo-api-specialist findings)

**Question:** The roadmap names `GET /task/{task_id}/projects` for the `--with projects` side-car, but the documented Freelo OpenAPI (`docs/api/freelo-api.yaml`) only defines `POST` (assign-to-project) and `DELETE` (remove-from-project) on that path. There is no documented `GET`. How should `--with projects` be fulfilled?

**Decision:** Project the embedded `multi_project_task` block from the already-fetched `TaskDetail` (OpenAPI :1676) into a top-level envelope key `data.projects`. No second HTTP call.

**Alternatives considered:**

- **Pause and ask the human** — heavy-handed; the documented `TaskDetail.multi_project_task` already answers the same question. Pausing here would burn budget on a slice with a documented answer.
- **Probe the live API for an undocumented `GET /task/{id}/projects`** — forbidden by the run config (`allowNetwork: false`).
- **Drop `--with projects` from v1** — loses a user-visible feature listed in the roadmap and the requirement.
- **Make a real HTTP call to `/task/{id}/projects` and hope for the best** — guesses API behavior; violates the autonomous-sdlc rule against undocumented endpoints.

**Rationale:** The OpenAPI explicitly documents that `TaskDetail` carries a `multi_project_task` block "mapping the task across its projects". That data answers the same question `--with projects` is meant to surface. Projecting it under `data.projects` (with `null` allowed for single-project tasks, distinct from the absent-key state when `--with` doesn't include `projects`) preserves the side-car semantics and stays on documented behavior. Forward-compatible: if Freelo ever publishes a real GET endpoint, R08.x can swap implementations without changing the envelope shape under `data.projects`.

**Roadmap reconciliation:** spec PR updates `docs/roadmap.md` line 193 to drop `GET /task/{task_id}/projects` from the endpoint list and add a one-line note explaining the embedded-projection.
