# Decision 2 — The id-space split is surfaced to the user; the CLI does not auto-probe

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** Simple taskchecks (`tasks_checks.id`) respond only on `/taskcheck/{id}…`; smart ones (`tasks.id`) return 404 there and are managed on `/task/{id}…`. Should `freelo taskchecks` require the user to hold the right kind of id, or should it probe `/taskcheck/{id}` and fall back to `/task/{id}` on 404?

**Decision:** User picks. `freelo taskchecks` talks only to `/taskcheck/{id}…`. A 404 is an error (exit 4) whose `hint_next` names the sibling `freelo tasks …` command and the `freelo subtasks list --task <parent-id>` discovery path. No fallback, no sniffing, no second request.

**Alternatives considered:**

- **Auto-probe with fallback to `/task/{id}` on 404.** Rejected — see rationale.
- **A `--kind simple|smart` flag that routes explicitly.** Rejected: it makes every invocation carry a flag whose value the user has to know anyway, so it buys nothing over separate command families while adding surface area.
- **Probe, but only for read-only verbs.** Rejected: all four verbs in this slice are writes, so the carve-out would be empty.

**Rationale:** `tasks_checks.id` and `tasks.id` are independent integer sequences with overlapping ranges, so a typo'd or stale taskcheck id is likely to be a *valid, live, unrelated task* the caller owns. Auto-probing would therefore not merely mask a wrong-id mistake — it would silently perform a destructive write on a different object than the user named, unrecoverably in the case of `delete` (soft-delete with no undelete endpoint). The UX cost of the chosen option is bounded at one failed call, because a deterministic discovery path already ships: `freelo subtasks list` passes the API's `type` discriminator (`subtask` | `taskcheck`) straight through `SubtaskSchema`'s `.passthrough()` into `freelo.subtasks.list/v1`. Spec 0066 §3 carries the full argument.
