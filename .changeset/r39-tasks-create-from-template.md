---
'freelo-cli': minor
---

Add `freelo tasks create-from-template` (R39 — closes Wave 6).

**Surface (additive — no breaking change):**

```
freelo tasks create-from-template <template_id> --source-task <id>
                                                 [--target-project <id>]
                                                 [--target-tasklist <id>]
                                                 [--date-start <YYYY-MM-DD>]
                                                 [--worker <id>]...
                                                 [--dry-run]
```

Copies a single task out of a project template into a target tasklist (or a
freshly-created project, when `--target-project` is omitted). Sibling of
`freelo tasklists create-from-template` (R34) — same flag family, different
endpoint.

**Endpoint:** `POST /task/create-from-template/{template_id}` (`docs/api/freelo-api.yaml:2187-2253`).

**Wire body:**

- `task_id` (required) — id of the **source task INSIDE the template**, mapped from the CLI flag `--source-task`. The roadmap's `--tasklist <id>` flag was a typo; the OpenAPI requires `task_id`. Mirrors the R34 reconciliation against a similarly-loose roadmap line.
- `target_project_id`, `target_tasklist_id`, `preset_date_from`, `users_ids` are optional, mirror the spec-0047 flag mapping (`--target-project`, `--target-tasklist`, `--date-start`, `--worker`).

**The roadmap's `--name` flag was dropped** — the OpenAPI documents no rename-on-copy field; we do not invent fields (`CLAUDE.md` hard rule).

**Output schema (new):** `freelo.tasks.create-from-template/v1` —
`{ template_id, task?: { id, name, tasklist: { id, name } }, would? }`.
Exactly one of `task` / `would` is set per envelope.

**Hint mapping for 4xx:**

- 400 mentioning `task_id` → "Source task id must reference a task INSIDE the template..."
- 400 mentioning `users_ids` → "Worker ids must be members of the template..."
- 400 mentioning `target_project_id` / `target_tasklist_id` → respective hints.
- 403 → permission hint.
- 404 → "Template not found. Run `freelo projects list --scope templates`..."

Non-destructive (creates a task — no destructive effects). `--dry-run`
supported per the agent-safe-writes contract; no `--yes` required.

Single-id v1. Batch (`--ids` / `--stdin`) is not supported. Spec:
`docs/specs/0053-r39-tasks-create-from-template.md`.

This slice **closes Wave 6**: R35–R39 are now all shipped.
