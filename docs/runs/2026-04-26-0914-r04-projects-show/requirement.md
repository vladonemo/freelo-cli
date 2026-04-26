# Requirement — R04 `freelo projects show <id>`

**Run:** 2026-04-26-0914-r04-projects-show
**Source:** `docs/roadmap.md:119-123`

## Verbatim from roadmap

> ### R04 — `freelo projects show <id>`
> **Outcome:** See one project's full metadata, workers, and labels.
> **Endpoints:** `GET /project/{id}`, `GET /project/{id}/workers`.
> **CLI:** `freelo projects show <id> [--with workers,labels]`
> **Depends on:** R03.

## Run flags

- Budget: default (30 min, 40 calls, 8 retries, 25 files)
- `--allow-network`: false (MSW only; api-specialist works from `docs/api/freelo-api.yaml`)
- `--ship`: false (PR open is the end state)

## Triage hint

Yellow likely. New command + new envelope schema. Reuses everything from R03. No auth/HTTP-defaults touch.

## Branch

`feat/projects-show` off `origin/main` (currently `17a7c72` post-0.6.0).
