# Decision 4 — Re-tier the run from Red to Yellow, not Green

**Run:** 2026-07-27-1211-tasks-edit-validation
**Phase:** Risk-tier gate
**Agent:** orchestrator

**Question:** The pause that made this run Red is resolved. Which tier governs the merge
gate now?

**Decision:** **Yellow** — open the PR, leave it for human review, do not enable
auto-merge.

**Alternatives considered:**

- **Stay Red.** Rejected: all three Red triggers are extinguished. "API behavior not in
  `freelo-api.yaml`" — the yaml documents `FileBasic` fully (`:5558`) and agrees with the
  fix. "Spec contradicts the OpenAPI spec" — the contradiction was our own schema, now
  removed. "Touches `src/api/client.ts`" — the fix touches only
  `src/api/schemas/task.ts`; the diagnostics option that would have touched `client.ts`
  was dropped (spec §5). "Unresolvable open questions" — none remain.
- **Green (auto-merge).** Rejected on three counts, below.
- **Yellow (chosen).**

**Rationale:**

Green requires *no breaking change to envelope schema*. `data.task.comments[].files[].id`
moves from "always a number, or the command hard-fails" to "may be absent". That
guarantee was counterfeit — it was the bug — and Freelo's own contract never promised it.
But it is still a consumer-visible weakening of a public envelope field, and CLAUDE.md
counts a retype as breaking. Per `autonomous-sdlc.md:40`, when signals conflict the
highest tier wins.

Second, the change relaxes a validation constraint shared by four commands (`tasks show`,
`tasks edit`, `tasks move`, `tasks description get`). Relaxations fail in the direction of
*not catching a real problem*, which is the failure mode least likely to show up in a
green test run — precisely the class that benefits from a human eye on the diff.

Third, this run entered as Red on a diagnosis that turned out to be wrong in every
particular. The corrected diagnosis is well-evidenced (live repro + OpenAPI + two
in-repo precedents), but auto-merging straight out of a resolved Red pause, with no human
having seen the actual diff, would over-claim confidence. Green's own examples are doc
edits, internal refactors, read-only subcommands, and test additions; a validation-contract
change on a shared schema is not that family.
