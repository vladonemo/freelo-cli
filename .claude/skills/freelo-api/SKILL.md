---
name: freelo-api
description: Cached knowledge of the Freelo.io REST API — auth, resources, pagination, rate limits, and known quirks. Load when building or maintaining any command that talks to Freelo. Kept current by the freelo-api-specialist agent.
---

# Freelo API — working reference

This skill is the repo's **cached** knowledge of Freelo's API. The authoritative source is always the official docs at <https://freelo.io/en/api/v3> (v3 at the time of writing). When in doubt, fetch.

## Base & versioning

- Base URL: `https://api.freelo.io/v1/` — **verify current version in official docs before a release**.
- All endpoints are REST+JSON. Responses are `application/json; charset=utf-8`.
- IDs are numeric (JSON numbers); we carry them as `number` in TS.

## Authentication

- HTTP Basic Auth: `email` as username, personal **API key** as password.
- The API key is obtained from the user's Freelo profile → API section.
- Our CLI stores the email and key as a pair per profile. Email is not a secret; the key is.

## Core resources (high-level)

| Resource | Typical endpoints |
|----------|-------------------|
| Projects | `GET /projects`, `GET /project/{id}`, `POST /projects` |
| Project workers / users | `GET /project/{id}/workers` |
| Tasklists | `GET /project/{id}/tasklists`, `POST /project/{id}/tasklists` |
| Tasks | `GET /tasklist/{id}/tasks`, `POST /tasklist/{id}/tasks`, `POST /task/{id}/finish` |
| Comments | `GET /task/{id}/comments`, `POST /task/{id}/comments` |
| Time tracking | `POST /timetracking/start`, `POST /timetracking/stop`, `GET /timetracking/reports` |
| Files | multipart upload endpoints on task/comment |

> Confirm exact paths against the current docs before implementing any specific command. This table is a map, not a contract.

## Pagination

- Many list endpoints accept `page` and `per_page` (1-based, max varies).
- Responses include a `total` count and often a `next_page` URL.
- Our client exposes `{ data, nextCursor }` shape; `nextCursor` is the next page number when more pages exist, else `undefined`.

## Rate limits

- Limits are **per API key**, applied as a sliding window.
- On `429`, response includes `Retry-After` (seconds). Our client honors it, capped at 60s, and logs at `warn`.
- Retries are **read-only**: GET only. POST/PUT/DELETE surface the 429 to the caller.

## Date/time semantics

- Timestamps in responses are ISO 8601 with timezone (usually UTC or Europe/Prague — **verify per-endpoint**).
- Our renderers show UTC by default, local time with `--local`.

## Error shape

Freelo error responses usually look like:

```json
{ "result": "error", "message": "Human readable reason" }
```

Status + message are surfaced; `requestId` (if present in headers) is logged at `debug` for support.

## Known quirks

> Add to this list as we discover things. Each entry needs a link to a fixture or a doc section.

- *(none recorded yet — add as we go)*

## How to verify before coding

1. Read the official docs page for the endpoint.
2. If behavior is unclear, ask the `freelo-api-specialist` agent to capture a real scrubbed response into `test/fixtures/`.
3. Model the response with zod in `src/api/schemas/<resource>.ts`.
4. Never hand a raw fetch response to business logic — parse first.
