# Requirement — R20

Verbatim from `docs/roadmap.md`:

> ### R20 — `freelo time stop` / `time edit`
>
> **Endpoints:** `POST /timetracking/stop`, `PATCH /timetracking/edit`.
> **CLI:** `freelo time stop [--note <str>]` / `freelo time edit [--note <str>] [--started-at <ISO>]`.
> **Depends on:** R19.

## Run parameters

- allowNetwork: false (MSW only)
- autoShip: false
- Budget: defaults — 30 min wall, 40 calls, 8 retries, 25 files
- Date: 2026-04-28
- Run id: `2026-04-28-2100-r20-time-stop-edit`
- Branch: `feat/time-stop-edit` (from `main` at `3bc38f9`)

## Notable contradiction with the OpenAPI spec

Roadmap says `PATCH /timetracking/edit`. OpenAPI (`docs/api/freelo-api.yaml:2811-2861`) says `POST /timetracking/edit`. Per orchestrator instructions ("If the OpenAPI spec contradicts the roadmap, follow the OpenAPI spec and note the discrepancy"), the implementation will use `POST`.

The roadmap also calls the flag `--started-at <ISO>` for `time edit`. OpenAPI's edit body only documents `task_id` and `note` — it does **not** mention a backdate field. So `--started-at` cannot be wired without inventing API behavior. See the spec for the routing of this concern.
