---
'freelo-cli': minor
---

Add `freelo tasklists list [--project <id>]` for browsing tasklists, with the
same `--page` / `--all` / `--cursor` / `--fields` / `--output` semantics as
`freelo projects list`.

Introduces the public envelope schema **`freelo.tasklists.list/v1`** with a
`data.scope: 'project' | 'all'` discriminator and `data.project_id` echo. Both
modes back onto the documented `GET /all-tasklists` endpoint
(`?projects_ids[]=<id>` for the per-project filter).
