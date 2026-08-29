# Requirement — 2026-08-29-1750-m05-task-label-colors

**Source:** `docs/roadmap-migration-2026-08.md` §M05 (line 150).
**Mode:** `allowNetwork: false` (MSW only), `autoShip: false`.
**Base:** `main` @ `705998c`.
**Recommended branch:** `feat/task-label-colors`.

## M05 — `freelo task-labels colors` (server-side palette)

**Outcome:** Expose Freelo's own accepted task-label palette, so the CLI stops
silently drifting from the server if Freelo changes it. Complements (or
replaces) the hardcoded nine-colour lookup table from R24.5 in
`src/lib/label-color.ts`.

**Endpoint:** `GET /task-label-colors`. To be verified against
`docs/api/freelo-api.yaml` directly — the roadmap summary is a hypothesis, not
a spec. M03 found three requirement claims the OpenAPI contract contradicted.

**CLI shape:** `freelo task-labels colors`.

**Central design question:** does this *replace* the hardcoded `PALETTE` in
`src/lib/label-color.ts` (fetched live, cached with a TTL), or ship as a
read-only discovery command *alongside* the existing hardcoded table, keeping
that table as the offline-safe default? To be weighed, not inherited from the
roadmap's recommendation. Must consider: `--palette` validation when the
network is down or the user is unauthenticated; whether a stale table failing
closed is better or worse than failing open; whether drift detection needs
anything beyond a human running the command.

**Depends on:** R24.5 (`src/lib/label-color.ts`, spec 0048).

**Tier:** roadmap calls it a Green candidate. Triage makes its own call.

## Also in scope — bookkeeping fix

M02 (`freelo tasklists edit`) shipped as PR #118 / commit `59a6d49` but its
roadmap section at line 68 was never marked shipped — bare heading, no check
mark, no `**Status:**` line, unlike M01/M03/M04/M07/M08. Bring it in line with
its shipped siblings.

## Budget

Defaults: 30 min wall clock, 40 agent invocations, 8 phase retries, 25 files
touched. Wall-clock overrun is to be logged as a decision, not treated as
grounds to shortcut the calibration §3 gate run. Do not pause on wall-clock
exhaustion.
