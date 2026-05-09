---
'freelo-cli': minor
---

Add `freelo projects workers list` and `freelo projects workers remove` (R32) — fourth slice of Wave 5 project admin.

**Surface:**

```
freelo projects workers list   --project <id> [--page N | --all] [--fields <list>]
freelo projects workers remove --project <id>
                               ( --user <id>... | --email <addr>... )
                               [--yes] [--dry-run]
```

`--user` and `--email` are mutually exclusive (different endpoints), each is repeatable into a single atomic POST.

**Envelope contracts (additive — public contract):**

- New schema `freelo.projects.workers.list/v1` — `data: { project_id, workers: UserBasic[] }`, plus standard `paging` and `rate_limit`.
- New schema `freelo.projects.workers.remove/v1` — `data: { project_id, removed_by: 'ids'|'emails', count, users_ids?, users_emails?, would? }`. `removed_by` is the discriminant; the matching sibling array is present on live success and on `--dry-run`. `would` is set only on `--dry-run`.

Wire endpoints (per OpenAPI :583-619, :676-757):

- `GET  /project/{id}/workers?p=N` — paginated; reuses the R04 wrapper `getProjectWorkers` plus the R03 `fetchAllPages` helper.
- `POST /project/{id}/remove-workers/by-ids` — body `{ users_ids: number[] }`.
- `POST /project/{id}/remove-workers/by-emails` — body `{ users_emails: string[] }`.

Both remove endpoints are atomic — the server fails the whole request if any single user can't be removed (no partial removal). The CLI does not map any HTTP error to `already_in_target_state: true` (the API behavior on re-call is not documented as idempotent; surfacing server errors as-is is the safer default).

Reuses `confirmDestructive` (R13) and the `--dry-run` helper (R09); no new dependencies.
