---
'freelo-cli': minor
---

Add `freelo tasks project add` / `remove` and `freelo tasks relations` / `find-relations` (R38).

**Surface (additive — no breaking change):**

```
freelo tasks project add    <id> --tasklist <id>... [--dry-run]
freelo tasks project remove <id> --project  <id>   [--yes] [--dry-run]
freelo tasks relations      <id>
freelo tasks find-relations --task <id>...
```

Four new leaves across two distinct surfaces:

**Multi-project membership (UVVP — `tasks project add` / `remove`).** Promotes a
single-project task into a cross-team task by creating a child task in another
project, or rolls back an accidental cross-team assignment.

- `add` → `POST /task/{id}/projects` with body `{ tasklist_id: <int> }`. Note:
  the body takes `tasklist_id`, **not** `project_id` — Freelo derives the project
  from the tasklist server-side. The CLI flag is named `--tasklist <id>` to match
  the wire reality (the roadmap text said `--project <id>...`, but the OpenAPI
  is authoritative; mirrors R36 share-verb precedent). `--tasklist` is
  repeatable; each value fans out to one POST. Duplicates are silently
  deduplicated. Non-destructive.
- `remove` → `DELETE /task/{id}/projects/{project_id}`. Single-id only;
  destructive, reuses the shared `confirmDestructive` gate from R13 / R35 / R36
  / R37. **Removing the task's *primary* project requires `freelo tasks delete <id>`
  instead** — Freelo returns `403 AclException` otherwise; the CLI surfaces this
  with a `hintNext`.

**Task relations (`tasks relations` / `find-relations`).** Read-only typed
cross-references between tasks (`blocked_by`, `blocks`, `related_to`,
`duplicate_of`).

- `relations <id>` → `GET /task/{id}/relations`. Single task; empty array on no
  relations is a valid 200.
- `find-relations --task <id>...` → `POST /tasks/relations` with body
  `{ task_ids: [<int>, ...] }`. Bulk; 1–100 ids per call (CLI enforces the cap
  client-side as `ValidationError`). **Inaccessible tasks are silently omitted**
  from the response by Freelo — agents diff `data.task_ids` against
  `data.tasks[*].task_id` to detect this.

> Despite the verb being `POST`, **`find-relations` is read-only** — the
> OpenAPI documents no endpoint to create or delete relations. Use the Freelo
> web UI to manage relations; use the CLI to query them.

**Output schemas (new):**

- `freelo.tasks.project.add/v1` —
  `{ task_id, tasklist_ids: int[], assignments?: { tasklist_id, child_task_id, child_task_uuid }[], would? }`.
- `freelo.tasks.project.remove/v1` —
  `{ task_id, project_id, already_in_target_state, would? }`.
- `freelo.tasks.relations/v1` —
  `{ task_id, relations: TaskRelation[] }` (read-only — no `would`).
- `freelo.tasks.find-relations/v1` —
  `{ task_ids: int[], tasks: { task_id, relations }[] }` (read-only — no `would`).

**Idempotency note for `project remove`:** A 404 response is **the documented
"task not in this project" signal** (yaml :1985) — re-classified as
`already_in_target_state: true`. A 403 response is **not** re-classified — it
is the documented "primary-project removal attempt" signal (yaml :1984) and
surfaces as `FreeloApiError` exit 4 with a `hintNext` pointing at `tasks delete`.

**`add` does not surface `already_in_target_state`** — wire ambiguity (mirrors
R37 `set` / R23 `labels attach` precedent). On a mid-fan-out failure, the
envelope's `assignments` array is truncated to the entries completed before the
failure.

**`relations` and `find-relations` do not support `--dry-run`** — read-only
operations have no side effect to skip; a dry-run envelope on a pure GET is a
no-op surprise.

Single-id v1 across all four leaves (with repeatable `--tasklist` / `--task`
flags where applicable). Batch via `--ids` / `--stdin` is not supported in this
slice. Spec: `docs/specs/0052-r38-tasks-multiproject-relations.md`.
