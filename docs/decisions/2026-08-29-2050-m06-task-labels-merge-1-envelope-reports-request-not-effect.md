# Decision 1 — The success envelope reports the request, not the effect

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** What can `freelo.task_labels.merge/v1` honestly say about a merge, given the API
returns `{"result": "success"}` and nothing else?

**Decision:** `data` carries `to_uuid`, `from_uuids` and `count` — all echoes of what was sent —
plus the constant `scope: "commander_projects"` (decision 2). It carries no `tasks_updated`, no
`tasks_skipped`, no `already_in_target_state`, and no `previous_state`. Their absence is pinned by
tests.

**Alternatives considered:**

- `tasks_updated` populated by a client-side pre-scan (list every task, count the ones carrying a
  source label, report that number). Rejected: the number would be a client-side guess at a
  server-side operation whose scope depends on commander access the CLI cannot enumerate, and it
  would be wrong in exactly the case where it matters — a large account with mixed access. It also
  turns a one-call command into an unbounded read fan-out.
- `already_in_target_state: false` hardcoded, for symmetry with `files delete`. Rejected on M03
  decision 5's reasoning: a repeat merge is a server-side no-op returning the same 200, so the
  value is unobservable and hardcoding it fabricates a measurement.
- Report nothing but `to_uuid` and a bare success. Rejected: echoing the de-duplicated
  `from_uuids` is genuinely informative — it is how a caller confirms the parse and the de-dup did
  what they expected — and it is not a claim about the server.

**Rationale:** The endpoint's 200 body is `SuccessResponse` (yaml :2974-2981). Everything the CLI
knows about this call, it knew before making it. Saying only that is the honest position, and it is
the same call M03 made when it omitted `already_in_target_state` rather than hardcoding it.
