# freelo task-labels find

List the task labels usable by the caller — uuid, name and color. Maps to Freelo's `GET /task-labels/find-available` endpoint.

This is the name→uuid resolver for task labels. Before it existed, the only ways to learn a task label's uuid were to scan every task via `GET /all-tasks` or to round-trip through `task-labels attach`. Neither is needed now.

> **Not the same as [`freelo labels list`](./labels-list.md).** That command lists **project**-labels, which are keyed by a numeric `id`. Task labels are a separate Freelo concept, keyed by `uuid`, and have no `id`. Different endpoint, different resource, different output shape.

## Synopsis

```bash
freelo task-labels find [--project <id>]
```

## Options

| Flag             | Type / values    | Default | Purpose                                                                                               |
| ---------------- | ---------------- | ------- | ----------------------------------------------------------------------------------------------------- |
| `--project <id>` | positive integer | —       | Restrict results to labels used in that one project. Omitted → every task label usable by the caller. |

`--output`, `--profile`, `-v`/`-vv`, `--request-id` are inherited global flags.

Read-only: there is no `--dry-run` and no confirmation gate.

## Results and ordering

Results are sorted by `name` ascending. The sort is done server-side; the CLI does not re-sort, so the order you get is the order Freelo returns.

The endpoint covers labels attached to tasks across the caller's owned and invited projects in `ACTIVE`, `ARCHIVED` **and** `TEMPLATE` state — so a label that only appears on an archived project's tasks still shows up.

## An empty result is a success, not an error

`freelo task-labels find` exits **0** with `labels: []` in three different situations, and **the API does not tell us which one applies**:

1. The labels genuinely don't exist — nothing is labelled yet.
2. `--project` names a project you can't access (or that doesn't exist). The API returns an empty list rather than a 403 or 404.
3. Your account has no accessible projects at all.

All three come back as HTTP 200 `{ "labels": [] }`. The CLI does not invent a 404 or a non-zero exit for any of them, because it cannot distinguish them. If you get an unexpected empty list with `--project`, double-check the project id against `freelo projects list` — a typo looks exactly like an empty project.

Scripts should therefore treat "empty" as "no data", not "failure", and check `data.count` rather than the exit code.

## Permissions

- Requires only a valid API key — task labels live at the account level.
- `--project` requires that you own or are invited to the project. A project outside your access yields an empty list, not an error (see above).

## Envelope

`schema: "freelo.task_labels.find/v1"`

```json
{
  "schema": "freelo.task_labels.find/v1",
  "data": {
    "labels": [
      { "uuid": "0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d", "name": "Bug", "color": "#e9483a" },
      { "uuid": "3a1c9d8e-7f6a-5b4c-3d2e-1f0a9b8c7d6e", "name": "Chore", "color": "#77787a" }
    ],
    "count": 2,
    "project_id": 42
  },
  "rate_limit": { "remaining": 4998, "reset_at": "2026-08-25T11:00:00+02:00" }
}
```

| Field        | Notes                                                                                                          |
| ------------ | -------------------------------------------------------------------------------------------------------------- |
| `labels[]`   | `uuid`, `name`, `color`. No `id` field — task labels are uuid-keyed.                                           |
| `count`      | Number of labels returned. `0` on an empty result.                                                             |
| `project_id` | Present **only** when `--project` was passed. Lets a consumer tell a scoped empty result from an unscoped one. |

There is no `paging` — the endpoint returns the full set in one shot.

## Examples

### List every task label you can use

```bash
freelo task-labels find
```

```
UUID                                  NAME   COLOR
0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d  Bug    #e9483a
3a1c9d8e-7f6a-5b4c-3d2e-1f0a9b8c7d6e  Chore  #77787a
```

### Resolve a name to a uuid, then attach it

The workflow this command exists for. `task-labels attach --name` would create a new label if the name didn't match exactly; resolving to a uuid first attaches the label you actually meant.

```bash
UUID=$(freelo task-labels find --output json \
  | jq -r '.data.labels[] | select(.name == "Bug") | .uuid')

freelo task-labels attach --task 12345 --uuid "$UUID"
```

### See which labels are in use on one project

```bash
freelo task-labels find --project 42 --output json | jq '.data.count'
```

### Check for a label before creating it

```bash
if freelo task-labels find --output json | jq -e '.data.labels[] | select(.name == "Blocked")' > /dev/null; then
  echo "already exists"
else
  freelo task-labels create --name "Blocked" --palette red
fi
```

## Exit codes

| Code | When                                                           |
| ---- | -------------------------------------------------------------- |
| 0    | Success — **including an empty result**                        |
| 2    | `--project` is not a positive integer (`VALIDATION_ERROR`)     |
| 3    | Authentication failed (401)                                    |
| 4    | Server error (5xx), or a response body the CLI could not parse |
| 5    | Network failure                                                |
| 6    | Rate limited (429)                                             |

## See also

- [`freelo task-labels create`](./task-labels-create.md) — create label definitions
- [`freelo task-labels merge`](./task-labels-merge.md) — consolidate the duplicate uuids `find` just showed you
- [`freelo task-labels colors`](./task-labels-colors.md) — the color palette the server accepts, and whether the CLI's `--palette` names still match it
- [`freelo labels list`](./labels-list.md) — the **project**-label equivalent (id-keyed, different endpoint)
