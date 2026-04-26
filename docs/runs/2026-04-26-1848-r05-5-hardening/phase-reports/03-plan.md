# Phase 3 — Plan

**Run:** 2026-04-26-1848-r05-5-hardening
**Artifact:** `docs/specs/0015-r05-5-hardening.md` §10

Three commits proposed and executed:

1. `fix(api): tolerate null fullname and numeric currency amounts in response schemas`
   - `src/api/schemas/project.ts`, `src/api/schemas/tasklist.ts`
   - `src/api/client.ts`, `src/api/pagination.ts` — type plumbing for
     transform-aware schemas (`z.input` vs `z.output`).
   - `test/api/schemas/project.test.ts`, `test/api/schemas/tasklist.test.ts` (new)
   - `test/api/projects.test.ts`
   - `test/fixtures/projects/all-with-numeric-amounts.json` (new)
   - `docs/roadmap.md` (queued R05.5 entry travels into commit 1)
   - `.changeset/fix-r05-5-hardening.md`

2. `fix(errors): destroy undici dispatcher and defer exit to fix Windows libuv crash`
   - `src/errors/handle.ts` — `dispatcher.destroy()` + 250ms timeout race
     + `exitDeferred(code)` via `setImmediate`.
   - `src/bin/freelo.ts` — SIGINT handler + bootstrap `.catch` use the
     new `exitDeferred` helper.
   - `test/errors/handle.test.ts` — spy on `.destroy()` instead of
     `.close()`; new case for the timeout-race arm.

3. `test: regression for Windows libuv UV_HANDLE_CLOSING on zod-fail exit`
   - `test/integration/windows-libuv-exit.test.ts` (new) — Windows-matrix
     subprocess test asserting the **real condition** (no
     `UV_HANDLE_CLOSING` in stderr after a forced zod failure).

No new dependencies. 14 files changed total (well within the 25-file budget).
