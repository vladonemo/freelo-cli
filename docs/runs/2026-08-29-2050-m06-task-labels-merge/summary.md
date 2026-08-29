# Run summary — 2026-08-29-2050-m06-task-labels-merge

**Requirement:** M06 — `freelo task-labels merge` (last unshipped item in
`docs/roadmap-migration-2026-08.md`).
**Tier:** Yellow.
**Base:** `main` @ `3d87130`. **Branch:** `feat/task-labels-merge`. **Commit:** `270734d`.
**Mode:** `allowNetwork: false` (MSW only), `autoShip: false`.
**Outcome:** PR open, stopped before merge — https://github.com/vladonemo/freelo-cli/pull/121

## Phases run

All eight: triage, spec, plan, implement, test, review, security review, document, then commit /
push / PR. No phase skipped. No pause.

## Produced

- Spec: `docs/specs/0068-m06-task-labels-merge.md` (plan appended as a `## Plan` section)
- Command: `src/commands/task-labels/merge.ts`, `src/ui/human/task-labels-merge.ts`
- Wire: `mergeTaskLabels` + `buildMergeTaskLabelsBody` in `src/api/task-labels.ts`;
  `TaskLabelsMergeDataSchema` in `src/api/schemas/task-label.ts`
- Tests: `test/commands/task-labels/merge.test.ts` (37), six MSW factories in `test/msw/handlers.ts`
- Docs: `docs/commands/task-labels-merge.md`, cross-link from `task-labels-find.md`, README autogen
  block, roadmap M06 marked shipped
- Changeset: `.changeset/curly-donkeys-merge.md` (minor, schema called out)
- Decisions: `docs/decisions/2026-08-29-2050-m06-task-labels-merge-{1..7}-*.md`
- Phase reports: `phase-reports/report.md`

## Decisions made autonomously

1. Envelope reports the request, not the effect — no `tasks_updated`, no
   `already_in_target_state`.
2. One constant carried: `scope: "commander_projects"`, so a JSON consumer cannot read success as
   completeness.
3. `--from` is repeatable and comma-splitting; no `--ids`, no `--stdin` — the merge is already the
   batch. Deviation from the repo batch convention, logged.
4. The 404 is handled explicitly, stays an error, keeps a plain message; ACL nuance in `hint_next`.
5. The 404 hint points at `task-labels find` and states that it lists a superset of owned labels.
6. Self-merge rejected client-side (exit 2); case-differing duplicates de-duplicated.
7. Contract correction: no task-label delete endpoint exists, so post-merge leftovers are permanent.

## Gate results (clean committed tree at `270734d`, calibration §3)

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm test:cov` | 182 files / 3396 tests pass, 1 skipped, no coverage-threshold errors |
| `pnpm build` | pass |
| `pnpm check:readme` | up to date |

`merge.ts` 99.5% lines / 91.07% branches / 100% functions. Aggregate 95.41% lines / 84.03%
branches.

The first `test:cov` hit the known load-dependent `integration/windows-libuv-exit` failure — in the
documented environmental set, verified passing in isolation, and the second full run was clean.
That confirms the caution for a fourth time: `test:cov` bails before the coverage table when any
test fails, so budget for a second run rather than treating the first as the answer.

## Budget

| Resource | Cap | Used |
|---|---|---|
| Wall clock | 30 min | ~65 min — **overrun**, logged not paused (see below) |
| Agent invocations | 40 | well under |
| Phase retries | 8 | 1 (an exit-code correction in my own spec table, caught by the first test run) |
| Files touched | 25 | 23 |

**Wall-clock overrun.** Two full `pnpm test:cov` runs cost ~25 minutes on their own (748 s and
776 s), which alone exceeds the entire 30-minute budget before a line of code is written. This is
the fourth consecutive run to overrun on gate cost (M02, M03, M05, M06). M03 decision 7's argument
that the 30-minute default is mis-calibrated for this repo now has four data points behind it; the
cap is measuring machine speed, not agent efficiency. Recorded as a decision rather than a pause,
per the run instruction.

## What was NOT verified

- **Anything against a live Freelo account.** `allowNetwork: false` throughout; every request in
  this run was MSW. In particular: whether the server rejects a self-merge (the CLI fails it
  closed client-side because the contract is silent), and what a zero-task merge looks like end to
  end — by design it is indistinguishable from one touching ten thousand tasks.
- **Whether the commander-scope limit behaves as documented.** It is stated in the contract
  (yaml :2948) and surfaced everywhere the CLI can surface it, but no test can prove a server-side
  ACL behaviour through MSW.
- **CI on the PR head.** Checked at the end of the run against the actual head commit; see the
  final report. Local gates are not a substitute.

## Follow-ups left open

1. Run `freelo task-labels merge --dry-run` and then a real merge against a test account to confirm
   the two behaviours above. Not a code change.
2. The leftover source label definitions after a merge are permanent (decision 7). If Freelo ever
   adds a task-label delete endpoint, this becomes a natural follow-up slice; until then there is
   nothing to build.
3. `docs/roadmap-migration-2026-08.md` is now fully shipped (M01–M08). A new roadmap pass is the
   next natural piece of work.
