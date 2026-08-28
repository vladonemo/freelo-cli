---
'freelo-cli': minor
---

feat(commands): `tasks list --order-by due_date` (M08)

`freelo tasks list --order-by` now accepts a fifth value, `due_date`, alongside
`priority`, `name`, `date_add`, and `date_edited_at`. Previously it was rejected
client-side with `VALIDATION_ERROR` (exit 2) before a request was ever made.

The value is accepted on **both** task-listing routes, because the refreshed
OpenAPI contract (PR #112) documents it on both — `GET /project/{p}/tasklist/{t}/tasks`
and `GET /all-tasks`. The roadmap slice only knew about the first; the second was
confirmed by reading the contract rather than assumed.

```bash
freelo tasks list --project 42 --tasklist 101 --order-by due_date
freelo tasks list --order-by due_date --order asc --all
```

Freelo owns the sort; the CLI forwards the key and never re-sorts. Per the
contract: tasks with no due date always sort last (in both directions), all-day
tasks sort at the start of their day (00:00), and on `/all-tasks` equal due dates
are tie-broken by task id so pagination boundaries stay stable.

The spec-0060 board-order default is unaffected: passing `--order-by due_date`
alone on the per-tasklist route suppresses the injected
`order_by=priority&order=asc` for both halves, exactly as any other explicit
value does. Omitting both order flags still gets you the manual board order.

**Envelope:** no bump. `freelo.tasks.list/v1` stays `/v1` — no field is added,
removed, renamed, or retyped. `applied_filters.order_by` widens its value domain
by one string literal, and since `applied_filters` echoes only flags you passed,
a consumer can observe `"due_date"` there only in response to its own
`--order-by due_date`. No existing caller's payload changes.
