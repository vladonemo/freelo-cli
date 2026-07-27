# Decision 2 — Pause rather than autonomously relax the unused POST payload

**Run:** 2026-07-27-1211-tasks-edit-validation
**Phase:** Spec
**Agent:** orchestrator

**Question:** `editTask()`'s parsed `TaskDetail` is provably never consumed (only
`result.raw.rateLimit` is read; `data.task` comes from the refresh GET). Relaxing that
one call site to an opaque acknowledgement schema would fix the bug under all six
hypotheses without guessing the body. Should the run just do it?

**Decision:** No — surface it as the recommended option in `pause.md` and stop.

**Alternatives considered:**

- Implement it now: swap `schema: TaskDetailSchema` for a permissive ack schema at
  `src/api/tasks-edit.ts:94`, flip the `editMalformed` test row, ship a `patch` changeset.
- Implement it behind a flag / env escape hatch.
- Pause.

**Rationale:** It inverts an intentional, tested contract (`test/commands/tasks/edit.test.ts:930-948`
asserts exit 4 on a malformed POST response), permanently forfeits the chance to learn
the endpoint's real shape, and establishes a "don't validate what you don't read"
precedent against CLAUDE.md's "every network call is schema-validated". The requirement
also names `src/api/client.ts`-adjacent validation semantics as Red. Autonomous
decision-making covers "zod schema shape when spec is present"
(`.claude/docs/autonomous-sdlc.md:126`) — the spec here is blocked, so that permission
does not apply.
