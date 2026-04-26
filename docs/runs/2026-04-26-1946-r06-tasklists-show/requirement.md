# Requirement — R06 `freelo tasklists show <id>`

**Run id:** `2026-04-26-1946-r06-tasklists-show`
**Source:** `docs/roadmap.md` lines 166-170 (R06 entry).
**Branch:** `feat/tasklists-show` (from `main` at db9d1c3)

## Original input

> **Outcome:** Tasklist detail + assignable workers.
> **Endpoints:** `GET /tasklist/{tasklist_id}`, `GET /project/{project_id}/tasklist/{tasklist_id}/assignable-workers`.
> **CLI:** `freelo tasklists show <id> [--with assignable-workers]`
> **Depends on:** R05.

## Run flags

- Budget: defaults — 30m wall clock, 40 calls, 8 retries, 25 files.
- `--allow-network`: false (MSW only).
- `--ship`: false (PR open is end-state).

## Triage hint

Yellow likely. New command + new envelope schema. Reuses R04 + R05 infrastructure entirely. No new deps. No auth/HTTP-defaults touch.

## Caps actually in effect

| Resource | Cap |
| --- | --- |
| Wall clock | 30 min |
| Agent invocations | 40 |
| Phase retries (cumulative) | 8 |
| Files touched | 25 |
