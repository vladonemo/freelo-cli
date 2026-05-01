---
'freelo-cli': patch
---

fix(commands): tasks create --label now decomposes into create-then-attach,
fixing the live-API 400 "Missing item 'uuid' in array."

The `POST /project/{p}/tasklist/{t}/tasks` endpoint requires every label
entry to carry `{uuid, name, color}` together; name-mode is rejected. The
CLI now creates the task without labels, then issues a single batched
`POST /task-labels/add-to-task/<new-id>` for the requested names. Total
HTTP cost is two calls when `--label` is set, one call otherwise. On
attach failure the task is still created; `applied_labels.failed` carries
the diagnostic and a `freelo.error/v1` envelope lands on stderr.

Schema `freelo.tasks.create/v2` bumped — `data.would` retyped from object
to array (in --dry-run output, to describe both prospective calls);
`data.applied_labels` added to surface attach success/failure per label
name. The /v1 envelope was only emitted on a code path that returned 400,
so no working caller is affected.
