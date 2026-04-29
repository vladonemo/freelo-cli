# Requirement — R26 `freelo files list`

Source: `docs/roadmap.md:494-498`.

> ### R26 — `freelo files list`
>
> **Endpoints:** `GET /all-docs-and-files`.
> **CLI:** `freelo files list [--project <id>] [--task <id>] [--type doc|file|link|dir] [--page N|--all]`.
> **Depends on:** R25.

## Run config

- runId: `2026-04-29-1756-r26-files-list`
- Budget: defaults (30 min wall, 40 calls, 8 retries, 25 files)
- `allowNetwork`: false (MSW only; design from `docs/api/freelo-api.yaml`)
- `autoShip`: false (stop at PR)

## Pre-flight

- Working tree clean
- On `main`, fast-forwarded to `origin/main` (HEAD is `13b1a8f`)
- Lockfile current
