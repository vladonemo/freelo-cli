## Paused at triage

**Run:** 2026-04-27-2234-comments-list
**Reason:** R16 roadmap entry references endpoints/filters that the OpenAPI contract does not expose; orchestrator must not guess API behavior.
**Risk tier:** Red (pause-at-triage — requirement vs. API mismatch)

### What happened

The R16 roadmap entry (`docs/roadmap.md` line 335) says:

> **Endpoints:** `GET /task/{task_id}/comments`, `GET /all-comments`.
> **CLI:** `freelo comments list [--task <id>] [--project <id>] [--since DATE] [--page N|--all]`.

I checked `docs/api/freelo-api.yaml` for both endpoints and the implied filters. The contract diverges from the requirement in three material places:

1. **`GET /task/{task_id}/comments` is not in the spec.** Only `POST /task/{task_id}/comments` (create) is documented (`docs/api/freelo-api.yaml:2576-2617`). No GET counterpart, no alternative task-scoped comment-list path (greps for `comments_for_task`, `task-comments`, `tasks/.*comments` all empty).
2. **`/all-comments` does not accept a task filter.** Its query params are `projects_ids[]`, `type` (`all|task|document|file|link`), `order_by`, `order`, and `page` (`docs/api/freelo-api.yaml:2665-2726`). There is no `task_ids[]` parameter and no path variant scoped by task.
3. **`/all-comments` does not accept a `since`/`date_from` filter.** Only ordering by `date_add`/`date_edited_at` is offered; no time-window query param is documented.

Treating the requirement literally would require either (a) calling an endpoint that may not exist (`GET /task/{task_id}/comments`) or (b) inventing semantics for `--task` / `--since` by post-filtering page results, which breaks pagination semantics (a server page might contain zero matches; `--all` would have to scan everything; mixing `--page N` with a client-side filter gives a misleading count).

### Evidence

- `docs/api/freelo-api.yaml:2576-2617` — `POST /task/{task_id}/comments` only (no GET method)
- `docs/api/freelo-api.yaml:2665-2726` — `GET /all-comments` parameters and response schema
- `docs/api/freelo-api.yaml:5607-…` — `CommentFull` schema (response item shape)
- `docs/roadmap.md:335-339` — original requirement
- `.claude/docs/autonomous-sdlc.md` "Autonomous decisions vs. pauses": *"API behavior not in `docs/api/freelo-api.yaml` → Pause (don't guess the API)"*

### Decision needed

Which shape should `freelo comments list` take, given what the API actually offers?

Options:

  **A. Drop `--task` and `--since`; ship the global feed with `--project` and `--type`.**
  Map directly to `GET /all-comments` with these flags:
  - `--project <id>` (repeatable) → `projects_ids[]`
  - `--type <all|task|document|file|link>` (default `all`) → `type`
  - `--order-by <date_add|date_edited_at>` / `--order <asc|desc>`
  - `--page N` / `--all`
  Tradeoff: matches the API exactly, no surprises, no client-side filtering. Loses task-scoping that the roadmap promised; users wanting task-only comments must use `--type task` and post-filter, or wait for a later slice.

  **B. Same as A, plus a client-side `--since DATE` post-filter.**
  Stop paginating once `date_add < since` (server orders by `date_add desc` by default), so the cost is bounded. Document the limitation: `--since` is client-side and incompatible with `--page N` (only with `--all`).
  Tradeoff: gives users a useful filter without an API change; a little code complexity; behavior mostly intuitive but page-counts surprise users who mix `--since` with `--page N`.

  **C. Same as B, plus probe `GET /task/{task_id}/comments` empirically.**
  The OpenAPI spec is known to be incomplete in places (the spec was assembled by reverse-engineering). It is plausible that a GET exists but is undocumented. Build a small `freelo-api-specialist` capture: with `--allow-network` against a test account, probe the endpoint and either capture a fixture (and proceed with the original A+B+task plan) or confirm the 405 and fall back to A or B.
  Tradeoff: highest user value if the GET exists; requires network access (currently `allowNetwork: false`); adds investigation time. If the GET is confirmed to not exist, we still fall back to A/B.

  **D. Defer R16, ship something else.**
  Skip until the spec is updated or the GET is confirmed.

  **E. Abort the run.**

### Resume with

```
/resume 2026-04-27-2234-comments-list <A|B|C|D|E or free-form scope>
```

If choosing **C**, the run will pause again to request `--allow-network` plus a Freelo test API key; default of `allowNetwork: false` cannot be auto-overridden.

If choosing **B** (recommended given the no-network constraint), the spec will document `--since` semantics explicitly (client-side, requires `--all` or single page; cuts off pagination once items predate the boundary).
