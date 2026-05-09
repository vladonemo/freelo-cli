R32 — `freelo projects workers list` / `projects workers remove` (Wave 5, fourth slice).

CLI surface (per roadmap):
- `freelo projects workers list --project <id>`
- `freelo projects workers remove --project <id> (--user <id>... | --email <e>...) [--yes]`

Endpoints (verified against `docs/api/freelo-api.yaml`):
- `GET /project/{id}/workers` — paginated; inner key `workers`; items `UserBasic` (yaml :583-619).
- `POST /project/{id}/remove-workers/by-ids` — body `{ users_ids: integer[] }` (yaml :676-716).
- `POST /project/{id}/remove-workers/by-emails` — body `{ users_emails: string[] }` (yaml :718-757).

Roadmap said DELETE; OpenAPI says POST — OpenAPI wins.

Run parameters:
- allowNetwork: false (MSW only)
- autoShip: false
- budget: defaults (30 min wall clock, 40 agent calls, 8 retries, 25 files)

Branch base: main @ b8b21fa.
