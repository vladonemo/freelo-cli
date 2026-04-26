# freelo projects show

Show one project's full detail with optional side-cars (currently `workers`),
emitting a stable `freelo.projects.show/v1` envelope.

## Synopsis

```bash
freelo projects show <id> [--with workers]
```

## Arguments

| Argument | Type             | Required | Purpose                                          |
| -------- | ---------------- | -------- | ------------------------------------------------ |
| `<id>`   | positive integer | yes      | Numeric project id. Strings or 0/negative reject |

Validation runs before any HTTP call. A non-positive-integer `<id>` exits 2
with a clear message and no network traffic.

## Options

| Flag                  | Type / values                               | Default   | Purpose                                                                                                       |
| --------------------- | ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------- |
| `--with <list>`       | comma-separated; allowed: `workers`         | unset     | Include side-car payloads. Unknown values exit 2. The flag plumbing accepts a list for forward compatibility. |
| `--output <mode>`     | `auto` (default), `human`, `json`, `ndjson` | `auto`    | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                             |
| `--profile <name>`    | string                                      | `default` | Credential profile to use. Inherited global flag.                                                             |
| `--request-id <uuid>` | string                                      | unset     | Override the auto-generated request ID.                                                                       |

## Endpoints called

| When             | Endpoint                                      | Notes                          |
| ---------------- | --------------------------------------------- | ------------------------------ |
| Always           | `GET /project/{id}`                           | Returns rich `ProjectDetail`   |
| `--with workers` | `GET /project/{id}/workers?p=N` (one or more) | Paginated; iterates every page |

The mandatory call returns a `ProjectDetail` shape that already embeds a
trimmed worker list with `hour_rate`. `--with workers` supplements it with
the canonical paginated worker list (`UserBasic[]`, no `hour_rate`) — useful
when an agent needs the full list across all pages.

## Envelope

`schema: "freelo.projects.show/v1"`

```jsonc
{
  "schema": "freelo.projects.show/v1",
  "data": {
    "project": { "id": 42, "name": "...", "owner": {...}, "state": {...}, "tasklists": [...], "workers": [...] },
    "workers": [ { "id": 9, "fullname": "..." }, ... ]   // present only when --with workers
  },
  "rate_limit": { "remaining": 42, "reset_at": "2026-04-26T20:00:00Z" },
  "request_id": "..."
}
```

`data.workers` is **absent** (not `null`) when `--with workers` is omitted.
Agents can detect side-car presence with `'workers' in env.data`.

## Examples

### Agent (env auth, JSON)

```bash
$ FREELO_API_KEY=sk-... FREELO_EMAIL=agent@acme.cz \
    freelo projects show 42 --output json | jq '.data.project.name'
"Site redesign"
```

### Include the full paginated worker list

```bash
$ freelo projects show 42 --with workers --output json \
    | jq '.data.workers | length'
3
```

### Human (TTY)

```bash
$ freelo projects show 42 --with workers
Project #42 — Site redesign
  state:           active
  owner:           Owner Name (#9)
  date_add:        2026-01-15T10:00:00+01:00
  date_edited_at:  2026-04-20T14:32:00+01:00
  budget:          10000 CZK   (real: 2000 CZK)

Workers (3):
  id    fullname
  ----  ------------
  9     Owner Name
  17    Jane Doe
  23    Carol Smith
```

## Errors

| Code               | Exit | When                                                                            |
| ------------------ | ---- | ------------------------------------------------------------------------------- |
| `VALIDATION_ERROR` | 2    | Non-numeric `<id>`, non-positive `<id>`, unknown `--with` value, empty `--with` |
| `FREELO_API_ERROR` | 4    | 404 (project not found / no access), 403 (no permission), 5xx, etc.             |
| `NETWORK_ERROR`    | 5    | Network failure, DNS, timeout                                                   |
| `RATE_LIMITED`     | 6    | 429 from Freelo after retry budget exhausted                                    |

The 404 path emits a friendlier `hint_next` ("Project N not found, or your
account does not have access.") to disambiguate "doesn't exist" from "you
don't have permission".

## What's deliberately not here

- **`--with labels`** — promised by the original roadmap, but Freelo's
  documented API has no per-project labels read endpoint. Tracked for a
  future slice; see `docs/specs/0013-projects-show.md` §6 (Non-goals).

## See also

- [`freelo projects list`](./projects-list.md) — list projects across scopes
- [`freelo auth login`](./auth-login.md) — set up credentials
