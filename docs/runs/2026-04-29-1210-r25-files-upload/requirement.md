# Requirement — R25 `freelo files upload`

Source: `docs/roadmap.md` lines 487–492.

> ### R25 — `freelo files upload`
>
> **Endpoints:** `POST /file/upload` (multipart).
> **CLI:** `freelo files upload <path>... [--attach-to-task <id>]`.
> **Ships with this slice:** multipart body helper (`undici` `FormData` pattern), progress spinner via `ora`, size/type guards.
> **Depends on:** R08.

## Notes carried into triage / spec

- First multipart upload command in the CLI. This slice ships `src/lib/multipart.ts` (roadmap.md:753).
- R08 (auth/login) is shipped.
- Multiple paths supported (`<path>...`).
- `--attach-to-task <id>` semantics need to come from `docs/api/freelo-api.yaml`.
- `ora` progress spinner is human-only — lazy-loaded behind `isInteractive()`.
- Size/type guards: respect API limits if documented; otherwise decide-and-log a sane local guard.

## Knobs

- `allowNetwork`: false (MSW only)
- `autoShip`: false
- Budgets: defaults (30 min wall, 40 calls, 8 retries, 25 files)

## Run metadata

- Run ID: `2026-04-29-1210-r25-files-upload`
- Branch: `feat/files-upload` from `main@efcb1d4`
- Date: 2026-04-29
