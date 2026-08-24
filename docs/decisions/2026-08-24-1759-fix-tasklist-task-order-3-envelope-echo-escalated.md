# Decision 3 — Escalate the `applied_filters` echo question rather than decide it

**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Phase:** 3 — Plan
**Agent:** architect (executed inline by orchestrator)

**Question:** If the CLI starts injecting a default `order_by` / `order`, should
`applied_filters` in the `freelo.tasks.list/v1` envelope echo the injected default (8a) or stay a
user-supplied-only echo (8b)?

**Decision:** Recommend 8a in the spec, but do **not** decide — attach it to the human's §11
choice. Same for the related partial-supply sub-case (plan TODO-4: `--order-by name` with no
`--order`).

**Alternatives considered:**

- Decide 8a autonomously and log it. `autonomous-sdlc.md` allows "Small UX choices with a clear
  precedent in the codebase → decide, log".
- Decide 8b autonomously as the lower-blast-radius option.

**Rationale:** Neither qualifies as a small choice with clear precedent. `applied_filters` is part
of a released envelope contract, and 8a changes the observable JSON of an invocation that agents
already script against — an agent branching on `'order_by' in applied_filters` to detect "user
requested a sort" silently changes behavior. That lands under "Breaking behavior of an existing
command → **Pause**". 8b is not obviously safer: it makes the envelope under-report the request it
describes, which is the same opacity the fix exists to remove. The two options are genuinely in
tension on an agent-first CLI, the run is already pausing for §11, and the answer depends on which
§11 branch is taken — so the marginal cost of asking is zero.
