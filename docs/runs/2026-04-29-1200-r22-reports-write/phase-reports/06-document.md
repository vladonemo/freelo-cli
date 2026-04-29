# Phase 6 — Document (exit report)

**Run:** 2026-04-29-1200-r22-reports-write
**Status:** complete

## Pages added

- `docs/commands/reports-log.md` — synopsis, options, NDJSON shape, envelope, examples, error matrix, see-also.
- `docs/commands/reports-edit.md` — same shape; covers verb-binding-as-POST callout and the no-task / no-cost rationale.
- `docs/commands/reports-delete.md` — confirmation policy table, four-arm idempotency matrix, batch examples, agent-failure-mode example.

## README

`pnpm fix:readme` regenerated the autogen block (which lists every leaf command alphabetically by group). `pnpm check:readme` confirms it's now up to date. The regenerated README is staged with the rest.

## getting-started.md

Not modified — `reports log` is a sensible new-user entry point but the current getting-started content already covers `time start` / `time stop` for live tracking. Adding a `reports log` section would dilute the live-timer-first narrative; recommended as a follow-up doc PR.
