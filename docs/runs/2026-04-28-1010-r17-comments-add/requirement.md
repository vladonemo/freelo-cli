# R17 — `freelo comments add`

**Source:** `docs/roadmap.md` §R17

**Endpoints:** `POST /task/{task_id}/comments`.
**CLI:** `freelo comments add --task <id> (--message <str>|--from-file <path>|--editor|-)`.
**Depends on:** R16, R15 (editor pattern).

## Run config

- `allowNetwork`: false (MSW only)
- `autoShip`: false
- Budget: 30 min wall · 40 agent calls · 8 retries · 25 files
- Slug: `r17-comments-add`
- Run-id: `2026-04-28-1010-r17-comments-add`
- Started: 2026-04-28 10:10

## Pre-flight (verified by parent)

- Working tree clean on `main`
- `main` synced with `origin/main`
- `pnpm install --frozen-lockfile` succeeded
- Latest commits: R16 (#57), R15 (#56), R14 (#55), R13 (#54)

## Design pre-derived constraints

- Write command: needs `--dry-run` + envelope `freelo.comments.add/v1`
- Idempotency N/A (each POST creates a new comment) — document the choice
- NOT destructive — no `--yes` required
- Reuse `src/lib/input.ts` from R15; do not duplicate
- New flag: `--message <str>` for inline content; mutex with `--from-file`/`--editor`/`-`
- `comments` group already exists from R16
