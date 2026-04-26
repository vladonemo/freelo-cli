# Decision 1 — `assignable-workers` side-car has no pagination plumbing

**Run:** 2026-04-26-1946-r06-tasklists-show
**Phase:** spec
**Agent:** orchestrator (with api-specialist input)

**Question:** R04's `--with workers` uses `normalizePaginated` + `fetchAllPages`. Should R06's `--with assignable-workers` follow the same shape?

**Decision:** No. `/project/{pid}/tasklist/{tid}/assignable-workers` returns a bare `UserBasic[]` array (OpenAPI :1259-1262 confirms `type: array, items: UserBasic` — no wrapper). The R06 implementation calls `client.request({ schema: z.array(UserBasicSchema) })` directly and stores the result as `data.assignable_workers`.

**Alternatives considered:**

- Force the bare array through `normalizePaginated` for code-shape symmetry with R04 — rejected: it would corrupt the wire interpretation (the helper expects `{ total, count, page, per_page, data: { <key>: [] } }`) and would never terminate the page-walk.
- Add a synthetic pagination wrapper at the API-function layer so the command code looks identical to R04's `fetchAllWorkers` — rejected: hides the real wire shape, adds tests for pagination logic that doesn't exist on this endpoint.

**Rationale:** The side-car needs zero bytes of pagination code. Calibration §4 (new try/catch wrappers add untested branches): keeping the side-car simple keeps the command's branch count small, which keeps the coverage delta under control.

# Decision 2 — Read `project_id` from the detail response, no `--project` flag

**Run:** 2026-04-26-1946-r06-tasklists-show
**Phase:** spec
**Agent:** orchestrator (with api-specialist input)

**Question:** `/assignable-workers` requires `project_id` in the path; the user only supplies tasklist `<id>`. How does R06 get the project id?

**Decision:** `data.tasklist.project_id` from the `/tasklist/{id}` response is required per the OpenAPI contract (:5097-5098). The command reads it after the first call and uses it as the path parameter for the second call. The two HTTP calls are strictly sequential.

**Alternatives considered:**

- Add a `--project <id>` flag — rejected: defeats the discoverability of "show me this tasklist." The user usually doesn't have the project id at hand.
- Make a side call to `/all-tasklists` to discover the project id — rejected: requires another API call AND assumes the tasklist appears in the list (might not, e.g., archived).

**Rationale:** OpenAPI contract guarantees the field. Schema declares `project_id: z.number().int()` as required (no `.optional()`) — if the contract is ever broken, validation fails fast at the HTTP layer.

# Decision 3 — `TasklistDetail` is a new schema, not an extension of `TasklistFull`

**Run:** 2026-04-26-1946-r06-tasklists-show
**Phase:** spec
**Agent:** orchestrator

**Question:** R04's `ProjectDetail` extends `ProjectFull`. Should R06's `TasklistDetail` extend `TasklistFull` for symmetry?

**Decision:** No. `TasklistDetail` and `TasklistFull` have **partial** field overlap (see API memo §2). `TasklistFull` carries `state`, `budget`, `real_cost`, `real_minutes_spent`, `project` (object); `TasklistDetail` carries none of those but adds `project_id`, `tasks`. Extending `TasklistFullSchema` would require making 5+ fields `.optional()` — at which point we've effectively rewritten the schema.

**Alternatives considered:**

- Extend `TasklistFullSchema` and mark all R05 fields `.optional()` — rejected: silently weakens R05's schema, which would cause R05's tests to no longer assert the fields are present in list responses.
- Define a shared `TasklistBasic` and have both extend it — overkill for two consumers; deferred to a future refactor when a third consumer appears.

**Rationale:** Different shape; declare it as one. R05.5 hardening already taught us to use `passthrough()` for forward compatibility.

# Decision 4 — Envelope key is `assignable_workers` (snake_case)

**Run:** 2026-04-26-1946-r06-tasklists-show
**Phase:** spec
**Agent:** orchestrator

**Question:** URL is `/assignable-workers` (hyphenated). Envelope key options: `assignable-workers`, `assignable_workers`, `assignableWorkers`.

**Decision:** `assignable_workers` (snake_case).

**Alternatives considered:**

- `assignable-workers` — matches URL but forces JSON-key quoting in agent code (`data["assignable-workers"]`), inconvenient in JS/TS.
- `assignableWorkers` — camelCase is foreign to the wire format Freelo uses everywhere else.

**Rationale:** Every other multi-word field on the wire is snake_case (`real_minutes_spent`, `parent_task_id`, `due_date_end`). Matches how R04 envelopes use `data.workers`. Hyphens in JSON keys are awkward to access from agent code.
