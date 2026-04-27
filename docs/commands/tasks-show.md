# freelo tasks show

Show one task's full detail with optional side-cars for the long-form
description, paginated subtasks, and multi-project membership. Emits a
stable `freelo.tasks.show/v1` envelope.

## Synopsis

```bash
freelo tasks show <id> [--with description,subtasks,projects]
```

## Arguments

| Argument | Type             | Required | Purpose                                        |
| -------- | ---------------- | -------- | ---------------------------------------------- |
| `<id>`   | positive integer | yes      | Numeric task id. Strings or 0/negative reject. |

Validation runs before any HTTP call. A non-positive-integer `<id>` exits 2
with a clear message and no network traffic.

## Options

| Flag                  | Type / values                                                   | Default   | Purpose                                                                                               |
| --------------------- | --------------------------------------------------------------- | --------- | ----------------------------------------------------------------------------------------------------- |
| `--with <list>`       | comma-separated; allowed: `description`, `subtasks`, `projects` | unset     | Include one or more side-car payloads. Order-independent; duplicates collapse. Unknown values exit 2. |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson`                     | `auto`    | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                     |
| `--profile <name>`    | string                                                          | `default` | Credential profile to use. Inherited global flag.                                                     |
| `--request-id <uuid>` | string                                                          | unset     | Override the auto-generated request ID.                                                               |

## Endpoints called

| When                 | Endpoint                      | Notes                                                                                                          |
| -------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Always               | `GET /task/{id}`              | Returns the rich `TaskDetail` shape, including the embedded `multi_project_task` block when present.           |
| `--with description` | `GET /task/{id}/description`  | Returns one `Comment`. Tolerates empty descriptions (id/content may be null per OpenAPI).                      |
| `--with subtasks`    | `GET /task/{id}/subtasks?p=N` | Paginated; the command iterates pages until exhausted and merges into a single `data.subtasks` array.          |
| `--with projects`    | _(no HTTP call)_              | Projected from `data.task.multi_project_task` already returned by the detail call. May legitimately be `null`. |

The HTTP calls are **strictly sequential**: detail → description → subtasks.
This keeps error envelopes deterministic — a 404 on the detail call
short-circuits before any side-car runs. If a side-car call fails, the error
envelope's `hint_next` is scoped to the resource that failed (e.g. "subtasks
for task 9001 …") so you can distinguish "no such task" from "the task
exists but its description endpoint just 5xx'd."

## Envelope

`schema: "freelo.tasks.show/v1"`

```jsonc
{
  "schema": "freelo.tasks.show/v1",
  "data": {
    "task": {
      "id": 9001,
      "name": "Audit auth flow",
      "date_add": "2026-01-15T09:00:00Z",
      "date_edited_at": "2026-04-20T11:23:45Z",
      "due_date": "2026-04-30T00:00:00Z",
      "priority_enum": "m",
      "count_subtasks": 3,
      "cost": { "amount": "5000", "currency": "CZK" },
      "author": { "id": 9, "fullname": "Owner Name" },
      "worker": { "id": 17, "fullname": "Jane Doe" },
      "state": { "id": 1, "state": "active" },
      "labels": [{ "uuid": "lbl-1", "name": "urgent", "color": "#ff0000" }],
      "project": { "id": 42, "name": "Site redesign" },
      "tasklist": { "id": 314, "name": "Backend QA" },
      "comments": [
        /* embedded thread; may be null/absent */
      ],
      "total_time_estimate": { "minutes": 240 },
      "users_time_estimates": [
        /* per-user estimates */
      ],
      "tracking_users": [
        /* users currently tracking time */
      ],
      "multi_project_task": null,
    },
    "description": {
      // present only when --with description
      "id": 55501,
      "content": "We need to audit the OAuth2 flow end-to-end.",
      "date_add": "2026-01-15T09:05:00Z",
      "files": [],
    },
    "subtasks": [
      // present only when --with subtasks
      { "id": 8001, "task_id": 9001, "name": "Sub 1" /* ... */ },
    ],
    "projects": null,
    // present only when --with projects
    // null when single-project; an object when multi-project
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-26T20:00:00Z" },
  "request_id": "...",
}
```

Side-car key presence semantics — agents can rely on three distinct states:

- `data.description`, `data.subtasks`, `data.projects` are **absent** (not
  `null`, not `[]`) when their `--with` value was not requested. Detect with
  `'description' in env.data` etc.
- `data.subtasks` empty list renders as `[]` (key present, empty array).
- `data.projects` is **`null`** when the task is single-project (the wire
  response has no `multi_project_task` block), and an object when the task is
  multi-project. Three states matter: absent vs. null vs. object.

## Multi-project membership — why no separate endpoint?

The roadmap originally named `GET /task/{task_id}/projects` for `--with
projects`. That endpoint is **not documented** in the Freelo OpenAPI — only
`POST` (assign-to-project) and `DELETE` (remove-from-project) exist on that
path. The same data is already embedded in `TaskDetail.multi_project_task`,
so v1 projects that block into the envelope's `data.projects` slot — no
second HTTP call. If Freelo ever publishes a real GET, R08.x can swap
implementations without changing the envelope shape.

## Required Freelo permissions

Standard Basic auth from `freelo auth login` (or `FREELO_API_KEY` +
`FREELO_EMAIL`). The caller must have read access to the task's parent
project (and tasklist, when scoped). Freelo collapses ACL failures into 404,
and the CLI's `hint_next` says so explicitly.

## Examples

### Agent — fetch a task with everything

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz \
    freelo tasks show 9001 --with description,subtasks,projects --output json \
  | jq '.data | {worker: .task.worker.fullname,
                 description_len: (.description.content | length),
                 subtask_count: (.subtasks | length),
                 multi_project: (.projects != null)}'
```

### Agent — minimal pull, default `--output auto` resolves to JSON on non-TTY

```bash
$ freelo tasks show 9001 \
  | jq '.data.task | {id, name, due_date, priority_enum}'
```

### Agent — pull just the subtasks across all pages

```bash
$ freelo tasks show 9001 --with subtasks --output json \
  | jq '.data.subtasks[] | {id, name, state: .state.state}'
```

### Agent — branch on multi-project membership

```bash
$ freelo tasks show 9001 --with projects --output json \
  | jq 'if .data.projects == null
        then "single-project"
        else "multi-project (\(.data.projects.projects | length) projects)"
        end'
```

### Human (TTY)

```bash
$ freelo tasks show 9001 --with description,subtasks
Task: Audit auth flow (#9001)
Project:  Site redesign (#42)
Tasklist: Backend QA (#314)
State:    active
Worker:   Jane Doe
Author:   Owner Name
Due:      2026-04-30
Created:  2026-01-15
Edited:   2026-04-20
Priority: m
Subtasks (count): 3
Comments (count): 0
Labels:   urgent, backend

DESCRIPTION
We need to audit the OAuth2 flow end-to-end. Focus areas:

- token refresh boundary
- silent renewal
- scope downgrade

SUBTASKS
ID    NAME                              STATE     WORKER
8001  Sub 1 — collect endpoint inv...   active    Jane Doe
8002  Sub 2 — write threat model        finished  (none)
8003  Sub 3 — pen-test session login    active    Karel Novak
```

## Errors

| Code               | Exit | When                                                                                    |
| ------------------ | ---- | --------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | Non-numeric `<id>`, non-positive `<id>`, unknown `--with` value, empty `--with`.        |
| `AUTH_EXPIRED`     | 3    | 401 — credentials expired or invalid. Run `freelo auth login`.                          |
| `FORBIDDEN`        | 4    | 403 — no permission to view the task or one of its side-cars.                           |
| `NOT_FOUND`        | 4    | 404 — task not found OR caller has no access. Side-car 404s are scoped to the side-car. |
| `SERVER_ERROR`     | 4    | 5xx from Freelo. The hint passes the underlying message through unchanged.              |
| `NETWORK_ERROR`    | 5    | Network failure, DNS, timeout.                                                          |
| `RATE_LIMITED`     | 6    | 429 from Freelo after the retry budget is exhausted.                                    |

Each call site rewrites `hint_next` to mention the resource that failed:

- 404 on `/task/{id}`: "Task N not found, or your account does not have access."
- 404 on `/task/{id}/description`: "Description for task N not found …"
- 404 on `/task/{id}/subtasks`: "Subtasks for task N not found …"

5xx errors **do not** get the not-found hint injection — the underlying
hint is passed through, so a 502 from Freelo doesn't masquerade as a 404.

## What's deliberately not here

- **`--with comments`** — `TaskDetail.comments` already embeds the full
  thread. Adding it as a top-level side-car would duplicate data.
- **`--fields a,b,c` projection** — the `task` payload is large but agents
  prune client-side. Non-breaking to add later.
- **`--subtasks-page N` / `--subtasks-cursor C`** — subtasks fetch is
  opaque "all or nothing" in v1. Knobs are non-breaking to add later.
- **Parallel HTTP for the side-cars** — v1 is sequential for deterministic
  error ordering. Parallelization (description and subtasks are independent
  once `data.task` is fetched) is a future optimization, not a breaking change.
- **HTML rendering of the description** in human mode — v1 prints raw
  content. Agents read JSON anyway.
- **A real `GET /task/{id}/projects` HTTP call** — not in the documented
  OpenAPI. See "Multi-project membership" above.

## See also

- [`freelo tasks list`](./tasks-list.md) — enumerate tasks.
- [`freelo tasklists show`](./tasklists-show.md) — equivalent surface for tasklists.
- [`freelo projects show`](./projects-show.md) — equivalent surface for projects.
- [`freelo auth login`](./auth-login.md) — set up credentials.
