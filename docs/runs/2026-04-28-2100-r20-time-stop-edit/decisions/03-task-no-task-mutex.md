# Decision 3 — `--task` / `--clear-task` mutex pair on `time edit`

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** OpenAPI documents `task_id` as nullable on edit. How does the CLI surface "set to null"?
**Decision:** Two flags: `--task <id>` (assign) and `--clear-task` (disassociate, sends `task_id: null`). Mutex; both supplied → `ValidationError` exit 2.
**Alternatives considered:**
- Single `--task <id>` flag with sentinel value `0` for null — rejected; sentinel values are footguns.
- Single `--task <id|null>` literal — rejected; "null" as a string clashes with task names that are literally "null".
- Commander's negatable `--no-task` — **prototyped during implement, then rejected**: Commander's `--no-<flag>` clobbers `--task`'s storage with `false` when both are passed, so the mutex check would see only the last-on-argv signal. Independent storage via `--clear-task` lets the mutex check fire regardless of argv order.
**Rationale:** Independent option storage. The positive name reads cleanly alongside `--task <id>` ("set to id" / "clear to null").
