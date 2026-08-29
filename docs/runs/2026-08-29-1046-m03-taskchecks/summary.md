# Run summary — 2026-08-29-1046-m03-taskchecks

**Requirement:** M03 — `freelo taskchecks` (simple checklist items), from `docs/roadmap-migration-2026-08.md` §M03.
**Tier:** Yellow · **Type:** feat · **Branch:** `feat/taskchecks` · **Spec:** `docs/specs/0066-m03-taskchecks.md`
**Mode:** autonomous (`/auto`), `allowNetwork: false`, `autoShip: false`

> **This run was interrupted** between the final gate run and push/PR. It was picked up and closed out in a
> later session on the same day; that session committed decisions 8–10, re-ran the gates, re-verified the
> failure diagnosis, and wrote this summary. Everything below §Gates is from the closing session.

## Phases run

| # | Phase | Result |
|---|---|---|
| 1 | Triage | Yellow, no blockers. Id-space question argued as spec-resolvable, not a Red trigger |
| 2 | Spec | `docs/specs/0066-m03-taskchecks.md` — 0 open questions, 0 new deps |
| 3 | Plan | Appended to spec — 14 files estimated |
| 4 | Implement | 12 new source files, 2 modified (additive only) |
| 5 | Test | 87 tests (24 delete + 24 transition + 23 edit + 16 API unit) |
| 6 | Review | Self-review (inline — decision 1). No blocking findings |
| 6b | Security | **Not triggered** — no `src/config/`, auth, or secret surface |
| 7 | Document | 4 command doc pages, README autogen regenerated, changeset, roadmap updated |
| 8 | Commit | `b1d0e64` (feature), `c5a65a1` (decisions 8–10) |
| 9 | Push/PR | **Interrupted here.** Completed in the closing session |
| 10 | Risk gate | Yellow → **stopped before merge** |
| 11 | Ship | Not run (`autoShip: false`) |

## Budget

| Resource | Cap | Used | Status |
|---|---|---|---|
| Wall clock | 30 min | well over | **Over — logged as decision 7** |
| Agent invocations | 40 | 0 delegated (Task tool disabled — decision 1) | n/a |
| Phase retries | 8 | within cap | OK |
| Files touched | 25 | ~40 | **Over — logged as decision 7** |

Roughly half the file overrun is SDLC process artifacts (1 spec, 3 run artifacts, 10 decision records) rather
than product churn. Decision 7 argues the standard budgets are mis-calibrated for this repo's gate cost — a
single full-tree `test:cov` consumed 13–17 min of a 30 min wall-clock cap, twice.

## Verification of the requirement's load-bearing claims

The requirement asked for each API claim to be checked against `docs/api/freelo-api.yaml` rather than taken on
faith. Three of its claims did not survive that check:

1. **`notify_author` is not accepted by all four endpoints.** `deleteTaskcheck` and `activateTaskcheck` declare
   no `requestBody` at all. `--notify-author` ships on `edit` and `finish` only (decision 3).
2. **R11's idempotency pattern does not transfer**, for a structural reason: there is no `GET /taskcheck/{id}`,
   so prior state is unobservable and cannot be reported (decision 5).
3. **The M01/M07 "404 is ACL-ambiguous" rationale does not apply here** — those endpoints declare a `404`
   response object whose description says so; these four declare none. Right answer, wrong reason; re-derived
   from the one 404 meaning the yaml does document (decision 4).

## The central design question

**Id-space split — `freelo taskchecks` talks only to `/taskcheck/{id}…`; no auto-probe** (decision 2).

The two id sequences are independent and overlap in range, so a stale or typo'd taskcheck id is likely to be a
*valid, live, unrelated task the caller owns*. Auto-probing would not merely mask a wrong-id mistake — it would
perform a destructive write on a different object than the user named, unrecoverably for `delete`. A 404 is an
error (exit 4) whose `hint_next` names the sibling `freelo tasks …` command and the `freelo subtasks list`
discovery path.

## Decisions logged (10)

| # | Decision |
|---|---|
| 1 | Orchestrator ran the phases inline — sub-agent delegation unavailable |
| 2 | Id-space split surfaced to the user; no auto-probe |
| 3 | `--notify-author` on `edit` and `finish` only |
| 4 | 404 is never absorbed as idempotent success, on all four verbs |
| 5 | Envelopes omit `already_in_target_state` and `previous_state` |
| 6 | `edit` is single-id; `delete`/`finish`/`reopen` take batch input |
| 7 | Wall-clock and files-touched budgets overrun; run continued |
| 8 | Warm up the CLI module graph in `beforeAll` rather than accept first-test timeouts |
| 9 | No markdown emphasis in Commander `.description()` — it breaks `pnpm check:readme` |
| 10 | Local full-suite failures are pre-existing cold-start, not a regression |

## Gates (calibration §3 — run on the committed tree)

Re-run in the closing session on `b1d0e64`; fast gates re-confirmed on `c5a65a1`.

| Gate | Result |
|---|---|
| `pnpm typecheck` | pass |
| `pnpm lint` | pass |
| `pnpm build` | pass |
| `pnpm check:readme` | pass |
| `pnpm test:cov` | **11 failures, all verified environmental** — see below |

CI runs exactly `lint`, `typecheck`, `test:cov`, `build`, `check:readme` (`.github/workflows/ci.yml`).
`format:check` is **not** a CI gate; it fails identically on `main` for two unrelated files
(`docs/commands/custom-fields-rename.md`, `scripts/check-readme.mjs`) and was left alone.

### The 11 failures

Reproduced exactly across two independent full runs: same 8 files, 8 `Test timed out in 15000ms` plus 3
assertion failures from cross-test state bleed. **No failing test is in this slice** — the four taskchecks
suites passed all 87 tests in both runs. Seven of the eight files pass when re-run in isolation.

Two corrections the closing session made to decision 10, both appended to that record rather than edited in:

- **`windows-libuv-exit` was mis-filed.** Its failure is a 10 s watchdog *inside the test*, not vitest's 15 s
  `testTimeout`, and it still failed when the eight files were re-run together — so the isolation evidence
  never covered it. Run completely alone it passes, and it passes alone on `main` @ `59a6d49`. Same
  environmental conclusion, different mechanism; raising `testTimeout` would not fix it.
- **`test:cov` never emitted a coverage table.** Vitest bails on failures before reporting, so the
  branch-coverage threshold has not been measured locally on this branch in either run, despite ~30 min spent
  across the two. CI is the first place that number will actually be checked.

## Deviations from convention (called out for review)

- **No batch input on `edit`**, despite the CLAUDE.md "every write command" agreement — the batch surface pays
  off where the per-item payload is empty, which is `delete`/`finish`/`reopen` and not `edit`. Precedent:
  `tasks edit` (R10), `tasklists edit` (M02 decision 9). Decision 6.
- **Four doc pages, not the one** `docs/commands/taskchecks.md` the plan named — `docs/commands/` is one page
  per leaf command throughout the repo (`files-*`, `subtasks-*`, `tasklists-*`), and a user landing on
  `taskchecks-delete.md` needs the id-space warning on that page. Decision 7.
- **`finish`/`reopen` share one test file** (`transition.test.ts`) rather than the two the plan named, mirroring
  the shared `transition.ts` implementation and `tasks/transition.ts` precedent.
- **Self-review, not an independent `code-reviewer`** — sub-agent delegation was unavailable (decision 1).
  Weight the review accordingly.

## Follow-ups left open

1. **`Subtask.type` is undeclared.** `SubtaskSchema` (`src/api/schemas/task.ts:438`) still doesn't declare the
   `subtask` | `taskcheck` discriminator added to the yaml in PR #112; it reaches `freelo.subtasks.list/v1`
   only via `.passthrough()`. Declaring it — and retiring `inferStorageForm` (`src/api/subtasks.ts:100-133`) —
   is an R14 change with its own envelope-schema callout.
2. **Test cold-start.** Lift `warmUpCli()` into a shared `test/` helper and adopt it across the command suites,
   or raise `testTimeout` with a comment naming the cause. Note that neither fixes `windows-libuv-exit`, whose
   watchdog is its own.
3. **Lint rule for markdown in help text.** Decision 9's rule — never put `*` or `_` in a Commander
   `.description()` — is currently only written down. A `check-readme` warning would enforce it.
4. **Budget calibration.** Two consecutive runs (M02, M03) blew the 30 min wall clock on gate cost alone.
