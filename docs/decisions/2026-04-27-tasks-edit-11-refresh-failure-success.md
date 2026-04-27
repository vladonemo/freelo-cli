# Decision 11 — Refresh-GET failure → success envelope with `task: null` + `notice`

**Run:** 2026-04-27-tasks-edit
**Phase:** Spec / Implement
**Agent:** orchestrator (delegated to architect)

**Question:** All writes succeed; the post-edit refresh GET fails. What exit code? What envelope?

**Decision:** Exit 0. Emit a success envelope with `data.task: null` and a `notice` explaining the freshness gap.

**Alternatives considered:**
- Exit non-zero (the "complete success" promise wasn't met).
- Exit 0 with task: null and a notice (chosen).
- Exit 0 with the pre-edit task and a notice.

**Rationale:** The user's mutations succeeded. Promoting a freshness-read failure to a full failure misrepresents the state of the world. The notice tells the agent to re-fetch via `freelo tasks show <id>` if they need the post-edit detail.
