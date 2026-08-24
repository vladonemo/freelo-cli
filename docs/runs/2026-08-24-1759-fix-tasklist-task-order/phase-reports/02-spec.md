# Phase 2 — Spec

**Status:** complete, **blocked** (3 blocking open questions = architect's hard cap)
**Output:** `docs/specs/0060-tasklist-task-order.md`
**`freelo-api-specialist`:** not separately invoked — no `Task` delegation tool available this run;
its mandate (consult `docs/api/freelo-api.yaml`, never guess) was executed inline as spec §4.

## Substantive finding

The spec's contract analysis reweighted issue #108's own hypothesis ranking. Three observations
from the cached OpenAPI spec promote the issue's hypothesis 3 (`order_by=priority` may not mean
manual order) from footnote to leading candidate:

- `TaskSummary` exposes no ordering field of any kind (`freelo-api.yaml:5244-5298`)
- Freelo's task vocabulary already uses "priority" for `priority_enum` = `l | m | h` (`:1735-1739`)
- No endpoint anywhere reorders tasks within a tasklist; `POST /task/{id}/move/{tasklist_id}`
  (`:1842`) moves *between* tasklists and takes no position argument

Consequence: `order_by=priority&order=asc` might sort by L/M/H buckets, which would not fix #108.
Recorded as spec §4.4 and OQ-2.

## Open questions (all blocking)

- OQ-1 — what does the live endpoint return with no `order_by`?
- OQ-2 — what does `order_by=priority` actually sort by?
- OQ-3 — if not board order, is *any* `order_by` value board order, or is this a docs/upstream issue?

Spec §11 contains a single `curl` experiment that discriminates all four hypotheses, plus a
result-reading table.

```
ARCHITECT run=2026-08-24-1759-fix-tasklist-task-order status=blocked spec=docs/specs/0060-tasklist-task-order.md open_questions=3 new_deps=0
```
