# Requirement — R28 `freelo notifications`

**Source:** `docs/roadmap.md` lines 506-517 (verbatim).

> ### R28 — `freelo notifications`
>
> **Endpoints:** `GET /all-notifications`, `POST /notification/{id}/mark-as-read`, `POST /notification/{id}/mark-as-unread`.
> **CLI:**
>
> ```
> freelo notifications list [--unread] [--page N|--all]
> freelo notifications read <id>... [--all-unread]
> freelo notifications unread <id>...
> ```
>
> **Depends on:** R01.

## Run config

- runId: `2026-04-29-2030-r28-notifications`
- Budget: defaults (30 min wall, 40 calls, 8 retries, 25 files)
- allowNetwork: false (MSW only)
- autoShip: false (stop at PR open)

## Branch base

- main @ `d89b52f` (R27 merge commit) — verified clean.
