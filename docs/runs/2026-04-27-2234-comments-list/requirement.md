# Requirement — R16 `freelo comments list`

Source: `docs/roadmap.md` line 335 (Wave 3 — Collaboration).

## Summary

R16 introduces the first command in a new `comments` resource group: a read-only list operation across two endpoints.

- **Endpoints:** `GET /task/{task_id}/comments`, `GET /all-comments`
- **CLI:** `freelo comments list [--task <id>] [--project <id>] [--since DATE] [--page N|--all]`
- **Depends on:** R08 (already shipped)

## Run parameters

- `allowNetwork`: false (MSW-only)
- `autoShip`: false (no `npm publish`; PR only)
- Budget: 30 min wall, 40 agent calls, 8 retries, 25 files (defaults)

## Notes

- New read-only command; first under `comments`.
- No auth/config touched, no new runtime deps anticipated.
- Likely Yellow per autonomous-sdlc.md ("New user-visible command").
- Pause if `GET /all-comments` shape isn't in `docs/api/freelo-api.yaml`.
