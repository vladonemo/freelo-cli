# Requirement — R29 `freelo projects create`

R29 — first slice of Wave 5.

## Outcome
Create a project from the CLI.

## Endpoint
`POST /projects` (verified against `docs/api/freelo-api.yaml:189-234`).

## CLI surface (per roadmap)
`freelo projects create --name <str> [--date-start YYYY-MM-DD] [--currency <code>] [--project-owner-id <id>]`

## Depends on
R04 (`projects show`) — already shipped.

## Tier expectation
Yellow (new user-visible command, additive, no auth/HTTP-default changes; changeset minor).

## Run parameters
- `allowNetwork: false` — MSW only.
- `autoShip: false` — release human-driven via `/ship`.
- Budget: defaults (30 min wall clock, 40 agent calls, 8 retries, 25 files).

## Important context
- Reuse Wave 2 shared write infra (`src/lib/dry-run.ts`, `src/lib/batch.ts`, `--dry-run`, `--stdin` NDJSON, idempotency, confirm). Do not reintroduce.
- Schema: `freelo.projects.create/v1`.
- `--dry-run` mandatory per CLAUDE.md write-command policy.
- Stay within R29's scope; do not expand into R30 (archive/activate/delete) or R31 (create-from-template).
