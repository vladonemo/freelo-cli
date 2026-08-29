# Decision 9 — No batch input (`--ids` / `--stdin` / repeated positionals) in this slice

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** `.claude/CLAUDE.md` says "Every write command supports `--dry-run`, batch input (`--id` repeatable, `--ids`, `--stdin` NDJSON), and idempotency". Does `tasklists edit` need a batch surface?

**Decision:** **No.** Single `<id>` positional only. `--dry-run` and idempotency are both provided.

**Alternatives considered:**

- Full R09/R13 batch surface (`--ids`, `--stdin` NDJSON, repeated positionals).
- `--ids` only, applying one identical flag set to N tasklists.

**Rationale:** The batch convention fits commands whose entire payload is *the id itself* — `tasks delete`, `files delete`, `comments delete`, `notifications mark`. `tasklists edit` is a partial update carrying eleven interacting flags, four mutex pairs, and a conditional confirmation gate. "Apply this identical body to N tasklists" is a narrow and mostly incoherent operation: renaming five tasklists to the same string, or setting them all to `--priority 1`, which is self-contradictory since the reorder is positional and each write shifts the others.

The genuinely useful batch form here is *per-line bodies* over NDJSON — a different and much larger design (per-line validation, per-line partial-success reporting now that `priority_applied` exists, per-line confirmation semantics for `--should-change-existing-tasks`). That is a slice of its own, not a rider on this one, and shipping a half-version now would be harder to change later than to add later.

This is a **deliberate, documented deviation** from the CLAUDE.md working agreement, not an oversight. Precedent for a single-id write in this repo: `tasks edit` (R10) and `comments edit` (R18) are both single-resource with no batch surface, so the convention is in practice already read as "batch where the id is the payload". Recorded in the spec's Non-goals and called out in the PR body so a human can overrule it.

**Idempotency** is satisfied without extra work: re-running the same edit re-applies the same values and returns 200. There is no "already in state" error to swallow, so there is nothing to special-case.
