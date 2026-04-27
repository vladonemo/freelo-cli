# Decision 1 — Pre-check via GET /task/{id} for idempotency, not post-hoc detection

**Run:** 2026-04-27-1435-r11-tasks-finish-reopen
**Phase:** spec
**Agent:** orchestrator (Opus 4.7)

**Question:** Should the idempotency check be pre-flight (`GET /task/{id}` before each verb) or post-hoc (parse the POST 200 response for an "already-in-state" marker)?

**Decision:** Pre-flight via `GET /task/{id}` before each POST.

**Alternatives considered:**
- Post-hoc detection only — fire the POST and parse the response for "no-op" markers.
- No idempotency at all — let the API decide and surface whatever 4xx comes back.
- Hybrid (pre-check only when the GET is already cached from another command — too complex for v1).

**Rationale:** The OpenAPI documents natural idempotency for `/activate` (active task → 200 without changes, line :1802) but says nothing about `/finish` on an already-finished task. Pre-checking via GET makes the behavior uniform across both verbs and unambiguous regardless of how Freelo decides to evolve the finish-on-finished response shape. Cost is +1 GET per id (in batch: 2× the request count); accepted because finish/reopen are low-volume verbs and the determinism is worth more than the latency.
