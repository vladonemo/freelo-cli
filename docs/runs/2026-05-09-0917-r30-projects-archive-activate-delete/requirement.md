## Requirement

R30 — `freelo projects archive` / `projects activate` / `projects delete` (Wave 5, second slice).

Per `docs/roadmap.md` Wave 5 entry:
- **Endpoints:** `POST /project/{id}/archive`, `POST /project/{id}/activate`, `DELETE /project/{id}` (verify against `docs/api/freelo-api.yaml`).
- **CLI surface:** three small commands. `archive` and `activate` are absorbing-state writes; `delete` is destructive and requires `--yes` (or TTY confirm).
- **Depends on:** R29 (just merged in `edfac24`), R13 (`src/lib/confirm.ts`).
- **Tier expectation:** Yellow (additive commands; minor changeset).

## Reuse

- `src/lib/confirm.ts` (R13) — destructive confirmation pattern.
- `src/lib/idempotency.ts` (R11) — absorbing-state `already_in_target_state: true` envelope helper.
- `src/lib/batch.ts` (R09) and `--ids` / `--stdin` NDJSON.
- `src/lib/dry-run.ts` (R09).

## Run parameters

- allowNetwork: false (MSW only)
- autoShip: false
- budget: defaults (30 min wall clock, 40 agent calls, 8 retries, 25 files)

## Calibration

- §6: branch from latest `main`.
- §7: any test that exercises a TTY-prompt path must clear `process.env['CI']`.

## Schemas

`freelo.projects.archive/v1`, `freelo.projects.activate/v1`, `freelo.projects.delete/v1`.
