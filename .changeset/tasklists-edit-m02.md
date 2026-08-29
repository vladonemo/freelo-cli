---
'freelo-cli': minor
---

Add `freelo tasklists edit <id>` (M02) — the first write command on tasklists other than `create`.

Rename a tasklist, set or clear its budget and time fund, manage followers and the default worker, and reorder it within its project:

```bash
freelo tasklists edit 9001 --name "Sprint 12" --budget 100000 --priority 1
```

**New envelope schema: `freelo.tasklists.edit/v1`.** `data` always carries `tasklist_id`, `priority_requested`, `priority_applied` and `applied_changes`; `data.would` is present under `--dry-run`. No existing schema is changed.

Notable behavior:

- **`--priority` is a POSITION, not an importance level.** It moves the tasklist within its project (1 = first). This is unrelated to `freelo tasks edit --priority low|normal|high`. Help text and validation errors call this out explicitly.
- **Partial success is possible and exits 0.** Freelo applies the reorder outside the transaction that commits every other field, so it can save the rename/budget/followers while failing the reorder. That surfaces as `data.priority_applied: false` plus a `notice`, with exit code 0 — agents should branch on `data.priority_applied`, not on the exit code, and retry only `--priority`.
- **`--should-change-existing-tasks` requires `--yes`** (or a TTY confirmation). It propagates the follower change to every existing task in the tasklist, and Freelo returns no record of what it touched. It is also only valid alongside `--tracking-users` / `--clear-tracking-users`.
- **`--budget` is in minor currency units**, digits only — `100000` means 1000.00. Decimals are rejected client-side with a clear message rather than a bare server 400.
- `--time-budget-minutes 0` sets a zero fund and is distinct from `--clear-time-budget`, which sends `null`.
