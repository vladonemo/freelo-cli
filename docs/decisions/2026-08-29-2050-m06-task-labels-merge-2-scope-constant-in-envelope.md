# Decision 2 — Carry `scope: "commander_projects"` as a constant in the envelope

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** The contract says replacement applies only to tasks in projects where the caller is a
commander (yaml :2948), so a "success" routinely leaves tasks untouched with no way to know how
many. Should the envelope say anything about that, given decision 1 forbids fabricated counts?

**Decision:** Yes — one constant field, `scope: "commander_projects"`, typed as `z.literal` so its
constancy is visible in the schema rather than inferred from the command source.

**Alternatives considered:**

- Say nothing in the envelope; put the caveat in help text, human output and docs only. This was
  the near-miss. Rejected because help text and docs cannot reach the primary consumer: an agent
  reading `--output json` sees an unqualified success and reasonably concludes the operation
  completed — which is the exact silent partial success this slice exists to make visible.
- A prose field (`note: "only tasks in projects where..."`). Rejected: prose in a machine envelope
  is neither stable nor matchable, and it invites more prose later.
- `partial_scope_possible: true`. Rejected as weaker — it says something is possible without saying
  what, so a consumer still has to go find the docs.

**Rationale:** What makes this consistent with decision 1 is that `scope` is not a measurement of
this call. It restates a contract fact that is true of every invocation, in a form a consumer can
branch on. A count would be a claim about what happened; a literal is a claim about what the
endpoint is.
