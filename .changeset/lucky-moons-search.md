---
'freelo-cli': minor
---

**`freelo task-labels find [--project <id>]`** — list the task labels usable by the caller (uuid, name, color), sorted by name. Wraps `GET /task-labels/find-available`.

This is the name→uuid resolver task labels never had. Previously the only ways to learn a task label's uuid were scanning every task via `GET /all-tasks` or round-tripping through `task-labels attach`; both are now obsolete. Pair it with `task-labels attach --uuid` to attach an existing label instead of risking a near-miss name that creates a duplicate.

Pass `--project <id>` to restrict results to labels used in a single project.

**An empty result is a success (exit 0), not an error.** The API returns `{"labels": []}` with HTTP 200 both when `--project` names a project you can't access and when your account has no accessible projects — and it does not distinguish those from "there genuinely are no labels". The CLI does not synthesise a 404 for any of them. Scripts should check `data.count` rather than the exit code.

New envelope schema: **`freelo.task_labels.find/v1`** — `{ labels: [{ uuid, name, color }], count, project_id? }`. `project_id` is present only when `--project` was passed. Note there is no `id` field: task labels are uuid-keyed, unlike the id-keyed project labels behind `freelo labels list`.

No existing envelope schema, flag, or exit code is changed.
