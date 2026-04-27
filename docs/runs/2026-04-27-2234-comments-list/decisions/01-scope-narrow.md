# Decision 1 — Narrow R16 scope to `/all-comments` only (option B)

**Run:** 2026-04-27-2234-comments-list
**Phase:** triage (resumed)
**Agent:** orchestrator (per human resume answer "B")

## Question

Which shape should `freelo comments list` take, given the OpenAPI contract diverges from the R16 roadmap entry (no `GET /task/{task_id}/comments`, no task filter on `/all-comments`, no `since` query param)?

## Decision

Ship `freelo comments list` mapped directly to `GET /all-comments` (the only documented read endpoint). Drop `--task` from this slice — it is deferred until Freelo confirms an undocumented `GET /task/{task_id}/comments` or adds one (see open question carried into the spec).

## Final flag set

- `--project <id>` (repeatable, → `projects_ids[]`)
- `--type <all|task|document|file|link>` (default `all`)
- `--order-by <date_add|date_edited_at>` (default `date_add`)
- `--order <asc|desc>` (default `desc`)
- `--page N` (1-indexed in the CLI, mapped to 0-indexed `?p=` on the wire) **or** `--all` (mutex)
- `--since DATE` — **client-side** post-filter; stops pagination as soon as an item's `date_add` falls before the cutoff (server default order is `date_add desc`, so iteration is bounded). **Mutex with `--page N`** — must be combined with `--all` (or run on a single default page). Validated at parse time → `ValidationError` exit 2 if violated.

## Alternatives considered

- **A:** drop `--task` and `--since`; only `--project` + `--type` + paging. Simplest, no client-side logic, but loses time-window filter that agents will reasonably want.
- **B (chosen):** A + client-side `--since`. Useful filter without API change, bounded cost (server's default `date_add desc` lets us short-circuit).
- **C:** B + probe `GET /task/{task_id}/comments` empirically. Required `--allow-network`, currently `false`. Would likely pause again.
- **D:** Defer R16 entirely.
- **E:** Abort.

## Rationale

The user picked B explicitly via the resume answer. It matches the API exactly except for one well-documented client-side filter, with strict mutex rules to avoid the most common foot-gun (`--page N` + `--since` would silently undercount).

## Roadmap follow-up

`docs/roadmap.md` R16 entry must be updated to:

- Drop `--task` from the v1 flag list.
- Footnote that task-scoped listing is deferred to a follow-up due to API spec gap (no documented `GET /task/{task_id}/comments`).

## Tier reassessment

Original triage paused with **Red** because of the requirement vs. API mismatch. With scope narrowed to a documented, additive, read-only command, the tier drops to **Yellow** per `.claude/docs/autonomous-sdlc.md` ("New user-visible command, additive schema"). Open PR, do not auto-merge — leave for human review.
