---
'freelo-cli': patch
---

fix(tasks): `tasks list --project <p> --tasklist <t>` now returns tasks in the tasklist's manual board order

On the per-tasklist route (`GET /project/{p}/tasklist/{t}/tasks`), omitting both `--order-by` and
`--order` previously sent no sort parameter at all, leaving the result order up to an unstated
server default. The CLI now explicitly requests `order_by=priority&order=asc` on that route, which
a live check against the Freelo API confirmed is the tasklist's manual / drag-and-drop board order
(and not the L/M/H task-priority field that shares the name). Fixes #108.

Passing either flag suppresses the default for both halves, so explicit `--order-by` / `--order`
values are honored exactly as before. `applied_filters` still echoes only user-supplied flags, so
the `freelo.tasks.list/v1` envelope is unchanged — no schema bump. The `/all-tasks` route is
untouched and keeps its own documented `date_add` default.

Also annotates the `order_by` parameter in the cached `docs/api/freelo-api.yaml` contract with what
`priority` actually sorts by, since the upstream spec documents the value but not its meaning.
