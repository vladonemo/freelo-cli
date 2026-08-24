# Decision 4 — `applied_filters` stays user-only (§8b); partial flag supply injects nothing

**Run:** 2026-08-24-1759-fix-tasklist-task-order
**Phase:** 4 — Implement (resumed)
**Agent:** orchestrator (delegated back by the human on resume)

**Question:** Under Option A, does `applied_filters` echo the injected `order_by`/`order` default
(spec §8a) or keep echoing only user-supplied flags (§8b) — and when the user supplies exactly one
of the two flags, is the other half defaulted (plan TODO-4)?

**Decision:** §8b — `applied_filters` continues to echo only what the user passed. And partial
supply injects **nothing**: the default is added only when *both* `--order-by` and `--order` are
absent, so `--order-by name` alone still goes out as `order_by=name` with no `order`, byte-identical
to pre-0060 behavior.

**Alternatives considered:**

- §8a (echo the injected default), the architect's standing recommendation from decision 3.
- `??`-defaulting per half, i.e. `--order-by name` also sends `order=asc` (the literal reading of
  plan TODO-1).
- Pause again and ask. The human explicitly delegated both sub-questions on resume
  ("use your judgment consistent with the rest of the spec if they still apply").

**Rationale:** Option A's live finding removes §8a's main argument. The injected value is now known
to equal what the server already applied on a bare request, so omitting it from `applied_filters`
under-reports the *request* but not the *behavior* — the envelope was never lying about the order
the caller got. §8a's cost is unchanged, though: it alters observable JSON for agents that branch on
`'order_by' in applied_filters` to mean "the user asked for a sort", which is a behavior change to a
released contract riding along inside a fix. Under A, §8b makes the whole change envelope-invisible
(no `/v2` bump, no consumer migration), and the "truthful echo" improvement can be specced on its
own merits later. Same logic drives TODO-4: injecting `order=asc` alongside a user's `--order-by`
would silently pin a direction the user did not choose, on a route where they previously got the
server's. Both halves absent is the only unambiguous "no preference expressed" signal, and it is
exactly the case #108 reports.
