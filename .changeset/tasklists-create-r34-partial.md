---
'freelo-cli': minor
---

Add `freelo tasklists create` and `freelo tasklists create-from-template` (R34, partial) — final write surface for the `tasklists` group, modulo the deferred `delete` (R34.5).

**Surface:**

```
freelo tasklists create --project <id> --name <str> [--budget <str>] [--dry-run]
freelo tasklists create-from-template <template_id> --source-tasklist <id> [--target-project <id>] [--target-tasklist <id>] [--date-start <YYYY-MM-DD>] [--worker <id>]... [--dry-run]
```

**Envelope contracts:** two new schemas (additive — public contract):

- `freelo.tasklists.create/v1` — carries `data.project_id` plus `data.tasklist: { id, name, budget? }` on live success or `data.would: { method, path, body }` on `--dry-run`.
- `freelo.tasklists.create-from-template/v1` — carries `data.template_id` plus `data.tasklist: { id, name, tasks }` on live success or `data.would: { method, path, body }` on `--dry-run`.

`--budget` is a verbatim digits-only string in base units (`"100000"` = 1000.00 of the project's currency) — no client-side parsing to avoid float drift. The `create-from-template` flag set is redesigned against the documented OpenAPI body (`tasklist_id`, `target_project_id?`, `target_tasklist_id?`, `preset_date_from?`, `users_ids?`) and intentionally does not match the roadmap's pre-OpenAPI shape.

`tasklists delete` is **deferred to R34.5**: `DELETE /tasklist/{id}` is not documented in `docs/api/freelo-api.yaml` as of 2026-05-09. Mirrors R29.5 / R33.5 deferral pattern (drop the surface whose OpenAPI backing isn't there; capture as a follow-up R-slice).
