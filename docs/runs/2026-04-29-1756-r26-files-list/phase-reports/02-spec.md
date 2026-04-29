# Phase 2 — Spec

**Run:** 2026-04-29-1756-r26-files-list
**Tier:** Yellow
**Output:** `docs/specs/0038-r26-files-list.md`

## Summary

Spec drafted for `freelo files list`, mapping to `GET /all-docs-and-files`. Three filters: `--project` (repeatable, → `projects_ids[]`), `--type` (CLI short forms `doc/file/link/dir` → wire `document/file/link/directory`), paging (`--page` 1-indexed CLI / `--all`).

## Decisions logged (3)

1. **Defer `--task <id>`** — endpoint doesn't accept a task filter; follow R23 precedent of defer + document instead of pausing.
2. **CLI `--type` accepts short forms only** — `doc/file/link/dir`, mapped to wire enum at parse time. Roadmap line is the contract.
3. **`applied_filters.type` carries the wire form** — agents round-tripping to Freelo's REST get a usable string.

## Open questions

None. No human gate before plan.

## Plan-phase ready

The spec already includes a `## Plan` section (file-level intent). Phase 3 (implement) can read directly from the spec.
