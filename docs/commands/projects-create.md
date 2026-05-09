# freelo projects create

Create a new project, emitting a stable `freelo.projects.create/v1` envelope.
First slice of Wave 5 (project admin); reuses the Wave 2 shared write
infrastructure (`--dry-run`).

## Synopsis

```bash
freelo projects create --name <str> --currency <CZK|EUR|USD> [--project-owner-id <id>] [--dry-run]
```

## Options

| Flag                      | Type / values                               | Required | Purpose                                                                                                               |
| ------------------------- | ------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------- |
| `--name <str>`            | non-empty string                            | yes      | Project name. Whitespace-only values exit 2.                                                                          |
| `--currency <code>`       | `CZK`, `EUR`, `USD`                         | yes      | Currency for budgets and invoicing in this project. Cannot be changed after creation. Mixed-case input is uppercased. |
| `--project-owner-id <id>` | positive integer                            | no       | Numeric user id assigned as project owner. Defaults to the authenticated caller. Must be an owner-eligible user.      |
| `--dry-run`               | flag                                        | no       | Skip the POST. The envelope echoes the body that _would_ have gone on the wire, with no rate-limit / request-id meta. |
| `--output <mode>`         | `auto` (default), `human`, `json`, `ndjson` | no       | `auto` resolves to `json` on a non-TTY, `human` otherwise. Inherited global flag.                                     |
| `--profile <name>`        | string                                      | no       | Credential profile to use. Inherited global flag.                                                                     |
| `--request-id <uuid>`     | string                                      | no       | Override the auto-generated request ID.                                                                               |

Validation runs before any HTTP call. Missing/empty `--name`, missing
`--currency`, an out-of-enum `--currency`, or a non-positive
`--project-owner-id` all exit 2 with a clear message and no network traffic.

## Endpoint called

`POST /projects`

Request body (built from the flags above):

```jsonc
{
  "name": "Q3 onboarding",
  "currency_iso": "EUR",
  "project_owner_id": 314, // omitted when --project-owner-id is not set
}
```

Response shape: `ProjectBasic` — `{ id, name }`.

## Envelope

`schema: "freelo.projects.create/v1"`

Live success:

```jsonc
{
  "schema": "freelo.projects.create/v1",
  "data": {
    "project": { "id": 9001, "name": "Q3 onboarding" },
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "...",
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.create/v1",
  "dry_run": true,
  "data": {
    "would": {
      "method": "POST",
      "path": "/projects",
      "body": { "name": "Q3 onboarding", "currency_iso": "EUR" },
    },
  },
}
```

Agents key off `data.project.id` (the new project's id) and `dry_run` to
distinguish live from dry-run envelopes. None of the documented fields are
removed, renamed, or retyped within `v1`; new fields are additive only.

## Examples

### Minimal — human and agent

```bash
$ freelo projects create --name "Q3 onboarding" --currency EUR
Created project #9001 (Q3 onboarding).

$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
    freelo projects create --name "Q3 onboarding" --currency EUR --output json
{"schema":"freelo.projects.create/v1","data":{"project":{"id":9001,"name":"Q3 onboarding"}},"rate_limit":{...}}
```

### With explicit owner

```bash
$ freelo projects create --name "Acme migration" --currency CZK --project-owner-id 314
Created project #9002 (Acme migration).
```

### Dry-run

```bash
$ freelo projects create --name "Test" --currency USD --dry-run --output json
{"schema":"freelo.projects.create/v1","dry_run":true,"data":{"would":{"method":"POST","path":"/projects","body":{"name":"Test","currency_iso":"USD"}}}}
```

## Errors and exit codes

| Trigger                                                   | Exit | Code               | Notes                                                                                      |
| --------------------------------------------------------- | ---- | ------------------ | ------------------------------------------------------------------------------------------ |
| Missing or empty `--name`                                 | 2    | `VALIDATION_ERROR` | Includes `--name is required.` or `--name cannot be empty.` in the message.                |
| Missing `--currency`                                      | 2    | `VALIDATION_ERROR` | Hint lists the three valid codes.                                                          |
| `--currency` not in `CZK`/`EUR`/`USD`                     | 2    | `VALIDATION_ERROR` | Hint lists the three valid codes.                                                          |
| `--project-owner-id` non-numeric or `<= 0`                | 2    | `VALIDATION_ERROR` | Hint mentions "numeric user id".                                                           |
| HTTP 400 — server-side validation (e.g. invalid owner id) | 4    | `FREELO_API_ERROR` | Hint mentions "owner-eligible user" when the body's `errors` reference `project_owner_id`. |
| HTTP 401                                                  | 3    | `AUTH_EXPIRED`     | Hint suggests `freelo auth login`.                                                         |
| HTTP 403                                                  | 4    | `FORBIDDEN`        | Hint mentions "permission to create projects".                                             |
| HTTP 422                                                  | 4    | `FREELO_API_ERROR` | Server message passed through.                                                             |
| HTTP 429                                                  | 6    | `RATE_LIMITED`     | Retryable.                                                                                 |
| HTTP 5xx                                                  | 4    | `SERVER_ERROR`     | Retryable.                                                                                 |
| Network failure                                           | 5    | `NETWORK_ERROR`    | Connection reset, DNS failure, etc.                                                        |

## Required Freelo permissions

The authenticated user must have project-creation permission on their account.
A 403 response indicates the account lacks the necessary role.

## Notes and intentional gaps

- **No `--date-start` flag in v1.** The OpenAPI body for `POST /projects` does
  not document a start-date field. We follow the OpenAPI as the authoritative
  source; the flag will be added in a follow-up if Freelo adds the field.
- **No `--stdin` / NDJSON batch input.** Project creation is rare and
  consequential enough that single-shot is the right v1. Add later if the use
  case surfaces.
- **Create is non-idempotent.** Posting the same body twice creates two
  projects. We do not synthesize an idempotency key. Agents that need
  at-most-once semantics should track the new id from the envelope.
- **Side effects on the server side** (per the OpenAPI): business-account
  captains are auto-invited as commanders/workers on the new project; events
  fire (`project_owner_assigner`, `project_commander_promote`) — webhooks and
  notifications subscribed to those will receive payloads.

## Related commands

- [`freelo projects list`](./projects-list.md) — discover existing projects.
- [`freelo projects show`](./projects-show.md) — read one project's full detail.
