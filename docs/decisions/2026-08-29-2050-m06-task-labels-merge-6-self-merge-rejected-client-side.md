# Decision 6 — Self-merge is rejected client-side; case-differing duplicates are de-duplicated

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** What happens when `--to` also appears in `--from`, or when the same uuid appears
twice in `--from` with different hex casing? The contract defines neither.

**Decision:** Self-merge (case-insensitive) is a `ValidationError`, exit 2, before any wire call.
Duplicate sources (case-insensitive) are silently de-duplicated, preserving input order and the
first spelling seen.

**Alternatives considered:**

- Send the self-merge and let the server decide. Rejected: the contract says nothing about it, so
  the outcome is unknown, and this is not a command to discover undefined behaviour on — whatever
  the effect is, it is irreversible and account-wide.
- Reject duplicates as an error too, for symmetry. Rejected: a `jq`-driven pipeline emitting a
  repeat is a convenience problem, not a user error, and the de-duplicated wire body is identical
  to the one the user meant. Failing there would push `sort -u` onto every caller for no safety
  gain.
- Treat uuids as case-sensitive strings throughout. Rejected: a uuid's hex is case-insensitive by
  definition, so `A` and `a` denote one label; treating them as two would send a redundant payload
  and would let a self-merge through under a different casing.

**Rationale:** Undefined destructive behaviour fails closed; harmless input noise is normalised.
The split follows which side of that line the ambiguity falls on.
