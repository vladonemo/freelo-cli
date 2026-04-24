---
name: freelo-api
description: Cached knowledge of the Freelo.io REST API — grounded in the official OpenAPI 3.0.3 spec checked in at docs/api/freelo-api.yaml. Load when building or maintaining any command that talks to Freelo.
---

# Freelo API — working reference

Authoritative source: **`docs/api/freelo-api.yaml`** (OpenAPI 3.0.3), pulled from <https://api.freelo.io/docs/v1/freelo-api.yaml>. Refresh it with:

```bash
curl -sSfL -o docs/api/freelo-api.yaml https://api.freelo.io/docs/v1/freelo-api.yaml
```

When the cached spec and this doc disagree, **the spec wins**. Update this doc, don't fix the spec locally.

## Base & versioning

- Base URL: `https://api.freelo.io/v1`
- OpenAPI: 3.0.3
- Single production server declared in the spec — no sandbox URL.
- Content type: `application/json; charset=utf-8` only.

## Required headers

Every request **must** include a `User-Agent` header identifying our app. Example:

```
User-Agent: freelo-cli/1.2.3 (+https://github.com/vladonemo/freelo-cli)
```

The client builds this from `package.json` version. Without it, Freelo may reject requests.

## Authentication

- HTTP Basic Auth: `email` as username, **API key** as password.
- The user obtains the key from <https://app.freelo.io/profil/nastaveni>.
- Our CLI stores `{ email, apiKey }` per profile. The email is not a secret; the key is.

## Pagination

- Query param: **`?p=<n>`, zero-indexed** (first page is `p=0`).
- No client-side page size — the server controls it.
- Paginated responses follow this shape (OpenAPI `PaginatedResponse` + `data`):

  ```json
  {
    "total": 137,
    "count": 25,
    "page": 0,
    "per_page": 25,
    "data": { "<resource>": [ ... ] }
  }
  ```

- Our client normalizes this to `{ data: T[], page, perPage, total, nextCursor }` where `nextCursor = page + 1` if `(page + 1) * per_page < total`, else `undefined`.

## Rate limits

- **Do not hardcode limits on the client.** The spec explicitly warns they change over time.
- On `429 Too Many Requests`, back off and retry.
- Our client: exponential backoff with jitter, max 3 attempts, **GETs only**. Writes surface the 429 as `RateLimitedError` so the caller (or a driving agent) can decide.
- **Rate-limit headers are captured on every response** (successful and failed) into `ApiResponse.rateLimit = { remaining, resetAt }`. The renderer forwards this into the JSON envelope's `rate_limit` field so agents can self-throttle across invocations.
- Log every retry at `warn` with the retry count.

## Error shape (Freelo → our envelope)

Freelo returns:

```json
{ "errors": ["Human readable reason", "Another error"] }
```

An array of strings — not a single `message`. No machine-readable `code` field. Our `FreeloApiError` captures the full array and reshapes it into our stable error envelope (see `.claude/docs/architecture.md` §Error envelope):

```ts
const FreeloErrorBodySchema = z.object({ errors: z.array(z.string()) });

// FreeloApiError exposes:
//   code:        'FREELO_API_ERROR' (stable)
//   httpStatus:  from HTTP response
//   requestId:   from X-Request-Id header (or our generated fallback)
//   errors:      string[] from the body
//   message:     errors.join('; ') or a status-derived fallback
//   retryable:   true for 429 / 5xx, false for 4xx (except 429)
//   hintNext:    derived from status + endpoint context
```

Mapping to our top-level error envelope emitted by `handleTopLevelError`:

```jsonc
{
  "schema": "freelo.error/v1",
  "error": {
    "code": "FREELO_API_ERROR",
    "message": "Forbidden",
    "errors": ["Forbidden"],
    "http_status": 403,
    "request_id": "7e6f0c3e-...",
    "retryable": false,
    "hint_next": "Run `freelo auth whoami` to verify token access.",
    "docs_url": "https://…"
  }
}
```

For distinguishing error types in code, switch on `FreeloApiError.httpStatus` and the endpoint context — never substring-match `message`.

## Currency encoding

From the spec: *"All currency amounts must be strings with exactly 2 decimal places multiplied by 100."*

This means a value of **99.95 EUR** is sent/received as the string **`"9995.00"`** — base-unit cents, expressed as a 2-decimal string. A `src/lib/money.ts` helper centralizes parse/format. Never do arithmetic on these as floats.

> Verify this interpretation with a real response before wiring a money-facing command. If it turns out they meant "9995" (integer cents as a string), the helper changes in one place.

## Resources (spec tags → endpoint groups)

Full list in the spec; summary of the 90 endpoints grouped:

| Tag | What it covers |
|---|---|
| Users | `/users/me`, `/users`, `/users/project-manager-of`, `/users/manage-workers`, out-of-office |
| Projects | list/get/create/archive/activate, workers, labels, pinned items, templates |
| Project Labels | find, CRUD, add/remove from project |
| Pinned Items | per-project pins, CRUD on `/pinned-item/{id}` |
| Tasklists | CRUD, assignable workers, create-from-template |
| Tasks | CRUD, move, finish/activate, descriptions, reminders, public links, estimates, subtasks, relations |
| Task Labels | CRUD at `/task-labels`, add/remove |
| Comments | list, create, CRUD per comment, `/all-comments` |
| Time Tracking | start/stop/edit/status — **one active session per user** |
| Work Reports | list, per-task, single-report CRUD |
| Issued Invoices | list, get, reports, `mark-as-invoiced` |
| Notifications | list, mark-as-read/unread |
| Events | activity feed |
| Files | upload, per-file lookup, `/all-docs-and-files` |
| States | enum of task states |
| Custom Fields | types, create/rename/delete/restore, add-or-edit-value, enum values |

## Endpoint path conventions

Two patterns coexist:

- **Resource-first**: `/project/{id}/tasklists`, `/tasklist/{id}/tasks` — for nested resources
- **Aggregate**: `/all-projects`, `/all-tasks`, `/all-comments`, `/all-notifications` — cross-resource lists with filtering

When both exist, prefer the aggregate for read commands that need cross-project views, and the nested form for scoped reads. Note this in the spec when designing a command.

## Known quirks

> Add as we discover them. Every entry cites a fixture or spec location.

- **`?p` is 0-indexed.** Easy to get wrong — our client enforces this in one place.
- **`per_page` is server-controlled**, not a query param. Don't expose it as a CLI flag.
- **Currency string encoding** — see above; verify interpretation on first money-related command.
- **Required `User-Agent`** — client enforces; tests assert the header is present.
- **Time tracking is singleton per user** — `/timetracking/start` with one running session returns an error; surface this as a user-friendly "already tracking X since Y" message.

## Codegen — open decision

The spec is OpenAPI 3.0.3 and complete. Two paths for `src/api/`:

1. **Hand-model with zod** (current scaffolded architecture). Pro: precise control, zod narrows beyond OpenAPI. Con: duplicated effort, drift risk.
2. **Codegen types and/or zod schemas** from the YAML. Candidates:
   - `openapi-typescript` — pure types, runtime-free
   - `openapi-zod-client` — zod + a typed fetch client
   - `kubb` — flexible, plugin-based

> This decision is **deferred** until the first real command is specced. Revisit in the Phase 1 spec for `auth` or `projects list` and pick based on spec fidelity. Whichever we pick, the zod layer stays the single source of runtime truth.

## How to answer an API question

1. Open `docs/api/freelo-api.yaml` and search for the path.
2. If the spec is ambiguous, the `freelo-api-specialist` agent captures a real (scrubbed) response into `test/fixtures/`.
3. Model the response with zod in `src/api/schemas/<resource>.ts`.
4. Never hand a raw fetch response to business logic — parse first.
