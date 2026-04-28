# Decision 1 — Singleton-409 hint enriches via opportunistic GET /timetracking/status

**Run:** `2026-04-28-1628-r19-time-start-status`
**Phase:** Spec
**Agent:** orchestrator (architect role)

**Question:** When `POST /timetracking/start` returns 409 ("Timetracking is already running."), should the CLI perform a follow-up `GET /timetracking/status` so the hint can name the active task and start time, or stay static?

**Decision:** Yes — opportunistic follow-up. On success, the hint reads "A time tracking session is already running (started <ISO> on task #<id> \"<name>\"). Use `freelo time stop` to finalize it as a work report, or `freelo time edit` to reassign the task / note (R20)." On follow-up failure (any non-200), fall back to the generic copy without the start-time / task-name details.

**Alternatives considered:**
- Static hint, no follow-up — rejected; the roadmap pinned "already tracking X since Y" as the ship condition, which requires the data.
- Force the user to run `time status` themselves — rejected; agents would have to chain calls just to surface a meaningful next step.
- Inline the active session in the error envelope itself (extra `error.context` block) — rejected; would expand the public error envelope contract beyond `freelo.error/v1`.

**Rationale:** One extra GET on an error path is cheap; the UX win is significant; the roadmap pins it as the ship condition. Falling back gracefully on follow-up failure preserves the original 409 signal even when the API is partially broken.
