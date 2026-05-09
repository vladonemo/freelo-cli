---
'freelo-cli': minor
---

Add `freelo projects invite` (R33) — fifth slice of Wave 5 project admin.

**Surface:**

```
freelo projects invite --project <id>...
                       [--user <id>...] [--email <addr>...]
                       [--dry-run]
```

`--project` is required and repeatable. `--user` and `--email` are **not** mutually exclusive — the wire body accepts both arrays in one call (decision 2; differs from R32 `workers remove` which routes to two different endpoints). At least one of `--user` / `--email` must be non-empty.

**Envelope contract (additive — public contract):**

- New schema `freelo.projects.invite/v1` — `data: { projects_ids, users_ids?, emails?, result?, would? }`.
  - `users_ids` / `emails` echoed only when supplied (post-dedup, in input order).
  - `result` present on live success — surfaces all four wire buckets (`newly_invited_users_to_projects`, `newly_created_users`, `newly_invited_users`, `removed_users_from_projects`) for agent inspection.
  - `would` present on `--dry-run`. Mutually exclusive with `result`.

Wire endpoint (per OpenAPI :3417-3498):

- `POST /users/manage-workers` — body `{ projects_ids: number[], users_ids?: number[], emails?: string[] }`.

Single bulk POST: one invocation = one HTTP call across all three input dimensions. Unknown emails trigger user creation server-side (via the documented "newly_created_users" response bucket).

Reuses the `--dry-run` helper (R09) and the repeatable-flag dedup pattern from R32. No `confirmDestructive` gate — invite is additive. No new dependencies.

**Out of scope for v1:** `--acl-tasklist` (body field not documented in the OpenAPI schema, only mentioned in description prose; tracked as R33.5), `--stdin` / NDJSON batch (endpoint is itself array-typed across three dimensions).
