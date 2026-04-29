# Phase 3 — Implement (exit report)

**Run:** 2026-04-29-1200-r22-reports-write
**Branch:** `feat/reports-write` (off `main` @ 7450ab4)
**Status:** complete

## Files added / modified

- `src/api/reports.ts` (extended) — `createReport`, `editReport`, `deleteReport` + path helpers + body builders.
- `src/api/schemas/report.ts` (extended) — `ReportProjectionSchema`, `projectReport`, three live + two dry-run data schemas.
- `src/commands/reports.ts` — wire `registerLog` / `registerEdit` / `registerDelete`.
- `src/commands/reports/log.ts` (new) — single-mode + `--stdin` batch.
- `src/commands/reports/edit.ts` (new) — single-mode + `--stdin` batch.
- `src/commands/reports/delete.ts` (new) — positional / `--ids` / `--stdin`; four-arm idempotency.
- `src/ui/human/reports-log.ts` (new), `reports-edit.ts` (new), `reports-delete.ts` (new).
- `test/msw/handlers.ts` (extended) — `workReportsWriteHandlers` family (log + edit + four delete arms + perIdRouter).

## Calibration rules upheld

- Rule 2: every `BaseError` subclass triggered by the three commands has an exit-code-asserting test.
- Rule 4: every new try/catch arm is covered (four delete arms + batch per-line catches in log / edit / delete).
- Rule 6: branch off fresh `main` (verified `git log -1 main` = 7450ab4).

## Smoke test

`node dist/freelo.js reports {log|edit|delete} --dry-run` end-to-end produced correct envelopes for all three commands.
