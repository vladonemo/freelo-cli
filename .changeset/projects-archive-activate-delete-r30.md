---
'freelo-cli': minor
---

Add `freelo projects archive` / `projects activate` / `projects delete` (R30) — second slice of Wave 5 project admin.

**Surface:**
```
freelo projects archive  <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
freelo projects activate <id>... [--ids "a,b,c"] [--stdin] [--dry-run]
freelo projects delete   <id>... [--ids "a,b,c"] [--stdin] [--yes] [--dry-run]
```

**Envelope contracts:** three new schemas (all additive — public contract):
- `freelo.projects.archive/v1` — `data: { project_id, current_state: "archived" }`
- `freelo.projects.activate/v1` — `data: { project_id, current_state: "active" }`
- `freelo.projects.delete/v1` — `data: { project_id, current_state: "deleted", already_in_target_state }`

`archive` and `activate` are absorbing-state writes — server-side idempotency means re-calling on an already-target project succeeds with a normal 200. `delete` is destructive (reuses the R13 `confirmDestructive` helper) and re-classifies a 404 as idempotent already-deleted (mirrors `tasks delete`). Soft-delete is reversible via `projects activate`.

All three commands support `--dry-run`, positional `<id>...`, `--ids "a,b,c"`, and `--stdin` NDJSON. No GET pre-check on the wire path (decision 1 in spec 0043) — agents that need observed previous state should call `freelo projects show` first.
