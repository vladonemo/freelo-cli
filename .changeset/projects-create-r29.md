---
'freelo-cli': minor
---

Add `freelo projects create` (R29) — first slice of Wave 5 project admin.

**Surface:**
```
freelo projects create --name <str> --currency <CZK|EUR|USD> [--project-owner-id <id>] [--dry-run]
```

**Envelope contract:** new schema `freelo.projects.create/v1` (additive — public contract). Carries `data.project: { id, name }` on live success or `data.would: { method, path, body }` on `--dry-run`.

Reuses Wave 2 shared write infra (`--dry-run`). Single-shot only in v1; NDJSON batch (`--stdin`) intentionally deferred. `--date-start` flag from the roadmap is dropped because the documented `POST /projects` body has no start-date field — tracked as a future R29.5 if Freelo adds it.
