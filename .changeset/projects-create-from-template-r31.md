---
'freelo-cli': minor
---

Add `freelo projects create-from-template` (R31) — third slice of Wave 5 project admin.

**Surface:**
```
freelo projects create-from-template <template_id> --name <str>
  [--owner-id <id>] [--currency <CZK|EUR|USD>] [--date-start <YYYY-MM-DD>]
  [--layout <rows|kanban>] [--worker <id>]... [--dry-run]
```

**Envelope contract:** new schema `freelo.projects.create-from-template/v1` (additive — public contract). Carries `data.template_id` (always) plus either `data.project: { id, name, owner?, currency_iso? }` on live success or `data.would: { method, path, body }` on `--dry-run`.

Every flag maps to a documented field in the OpenAPI request body for `POST /project/create-from-template/{template_id}`: `name`, `project_owner_id`, `currency_iso`, `preset_date_from`, `general_settings.layout`, `users_ids`. Reuses Wave 2 shared write infra (`--dry-run`) and R29's body-builder / hint-rewriter patterns. Single-shot only in v1; `--stdin` NDJSON intentionally deferred (project creation is rare).
