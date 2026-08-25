# Decision 4 — An empty result is exit 0; no synthesised 404 for an inaccessible `--project`

**Run:** 2026-08-25-1037-task-labels-find
**Phase:** spec / implement
**Agent:** orchestrator (architect + implementer mandates)

**Question:** `GET /task-labels/find-available` answers HTTP 200 `{"labels":[]}` when `project_id` names a project the caller can't access. Should the CLI turn that into a `NOT_FOUND` error, as it would for a genuinely missing resource elsewhere?

**Decision:** No. Empty list, exit 0, `count: 0`, in every case. The CLI never synthesises an error for an empty result.

**Alternatives considered:**

- Probe the project first (e.g. `GET /project/{id}`) and raise `NOT_FOUND` when that 404s, so `--project 999999` behaves like other id-taking commands. Rejected: doubles the request count for every scoped invocation to improve an error message, and it can still disagree with the labels endpoint's own ACL view. It also invents a failure mode the API deliberately doesn't have.
- Emit a `notice` on the envelope ("no labels — check the project id"). Rejected for v1: the envelope's `notice` field would fire on every legitimately-empty project, training users to ignore it. The ambiguity is documented in help text and `docs/commands/task-labels-find.md` instead.
- Exit 0 but print a warning to stderr. Rejected: same false-positive problem, and it adds stderr noise to a read command agents will call in loops.

**Rationale:** The requirement was explicit ("treat both cases as a legitimate empty result in the CLI, not a failure path") and the OpenAPI description confirms it for both documented arms. Three distinct situations — no labels, inaccessible project, no accessible projects — are indistinguishable on the wire, so any error the CLI synthesised would be a guess that's wrong some of the time. Reporting "not found" for a project that exists and is simply empty is the worse failure. Locked in by three tests, including one that asserts `project_id` is still echoed on the empty scoped result.
