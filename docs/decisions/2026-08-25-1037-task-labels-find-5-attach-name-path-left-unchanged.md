# Decision 5 — `task-labels attach --name` left unchanged (no workaround existed to remove)

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** The roadmap flags a possible follow-up: rewire `task-labels attach --name` to resolve uuids via the new endpoint instead of "its current round-trip-via-add workaround, if one exists". Does one exist, and is it in scope?

**Decision:** No change to `attach`. Verified there is no round-trip workaround to remove.

**Alternatives considered:**

- Resolve `--name` through `find-available` before attaching, so a typo fails loudly instead of creating a near-duplicate label. Rejected for this slice: the roadmap explicitly scopes it out ("Follow-up, not part of this slice"), and it would be a **behavior change to an existing command** — which `autonomous-sdlc.md` §Autonomous decisions lists as a **pause**, not a decide-and-log. Doing it here would also have pushed the change into a higher tier.
- Add a `--strict` flag to `attach` for resolve-first semantics. Same objection, plus new surface outside the requirement.

**Rationale:** Reading `src/commands/task-labels/attach.ts` and `buildAddTaskLabelsBody` shows `attach` sends name-mode entries straight to `POST /task-labels/add-to-task/{task_id}` and lets the server fetch-or-create. It never resolves a uuid client-side, so the premise of the follow-up ("if one exists") is false — there is nothing to un-hack. The real residual gap is that `attach --name` will create a duplicate on a typo; the mitigation shipped here is documentation (resolve with `find`, then `attach --uuid`), not a code change. Recorded in the roadmap so the follow-up isn't re-opened on a false premise.
