# Decision 7 — `--tracking-users` is repeatable, not variadic

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** The roadmap writes the flag as `--tracking-users <id>...`, i.e. a Commander variadic. Adopt that, or make it repeatable (`--tracking-users 12 --tracking-users 34`)?

**Decision:** **Repeatable**, via a `collectPositiveInt('--tracking-users')` accumulator. Values are deduped with first-seen order preserved.

**Alternatives considered:**

- Variadic `<id...>` as the roadmap wrote it.
- Comma-separated single value (`--tracking-users 12,34`).
- Both repeatable and comma-tolerant.

**Rationale:** Repeatable is the established convention for id-collecting flags on this CLI — `src/commands/tasks/edit.ts:74-79` (`collectPositiveInt`) backs `--worker`, and `--add-label` / `--remove-label` use the string equivalent. Matching it keeps the flag surface predictable across commands.

Variadic was rejected on a concrete footgun: a Commander variadic option greedily consumes every following token until the next `-`-prefixed one. `freelo tasklists edit 9001 --tracking-users 12 34 --priority 1` happens to parse correctly, but the form is fragile — any bare argument following the flag is silently swallowed into the id list rather than erroring, and the failure is invisible until the wrong follower set lands on the tasklist. Repeatable has no such ambiguity, and the cost is a few extra characters on a flag that typically carries one or two ids.

Comma-splitting was rejected because no existing flag in this CLI does it; introducing a second list syntax for one flag would be an inconsistency, and it collides conceptually with `--ids` (the batch-input convention in `src/lib/batch.ts`), which this command deliberately does not have (decision 9).

Deduping is applied because `tracking_users_ids` is a set on the wire and sending `[12, 12]` is meaningless; first-seen order is preserved so the `applied_changes` echo is deterministic and diffable. Mirrors `dedupePreserve` in `src/commands/tasks/edit.ts:269-279`.

**Deviation from the roadmap is deliberate** — the roadmap shape is a sketch, and this is the "new user-facing flag shape" case that `autonomous-sdlc.md` says to decide, log, and flag for review in the PR body.
