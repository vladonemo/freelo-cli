# Requirement — M02 `freelo tasklists edit <id>`

**Run:** 2026-08-29-0921-tasklists-edit
**Source:** `docs/roadmap-migration-2026-08.md` §M02 (merged to main in PR #112)
**Base:** `main` @ `21ea995`
**Mode:** autonomous (`/auto`), `allowNetwork: false`, `autoShip: false`

## Original input (verbatim)

Run the full autonomous SDLC pipeline (per .claude/docs/autonomous-sdlc.md) on this requirement, branching from `main`. I've already re-synced to `main` (git checkout main && git pull --ff-only) before launching you — re-verify in your own pre-flight per calibration #6 in autonomous-sdlc.md, don't trust ambient HEAD (sibling runs have repeatedly left the working tree on their own feature branch afterward).

**M02 — `freelo tasklists edit <id>`**, from `docs/roadmap-migration-2026-08.md` (merged to main in PR #112). First write command on tasklists other than create.

**Endpoint:** `POST /tasklist/{tasklist_id}/edit` — documented in `docs/api/freelo-api.yaml` (search for `editTasklist`). Re-verify every claim below against the actual spec text, not just this summary.

**CLI shape:** `freelo tasklists edit <id> [--name <str>] [--budget <amount>|--clear-budget] [--time-budget-minutes <n>|--clear-time-budget] [--worker <id>|--clear-worker] [--tracking-users <id>...|--clear-tracking-users] [--should-change-existing-tasks] [--priority <n>] [--dry-run]`.

**Load-bearing behavior notes from the roadmap slice — verify each against the spec, don't take on faith:**

1. **Currency encoding.** `budget` is documented as a string of minor currency units (e.g. `"100000"` = 1000.00), NOT a decimal string — decimal strings like `"100.50"` are rejected with 400 per the spec text. This codebase has a recurring bug history here (R05.5 bug #2: `CurrencySchema.amount` type mismatch; see `.claude/skills/freelo-api/SKILL.md` §Currency encoding, which itself says "verify this interpretation with a real response before wiring a money-facing command"). Check whether `src/lib/money.ts` (R22) already encodes this same convention before reusing it — don't assume, verify the helper's actual behavior matches what this endpoint wants.

2. **The `priority` naming trap, a third occurrence.** `priority` on this endpoint repositions the tasklist *within its project* (1 = first; others shift to fill the gap; out-of-range values clamp to last). This is NOT importance — same trap as task `order_by=priority` (issue #108, now shipped and understood) and the unrelated `priority_enum` (l/m/h) field elsewhere in the API. Flag name should match the wire field (`--priority`), but help text and any validation error messages must be unambiguous that this is positional ordering, not importance — a user who's seen `priority_enum` elsewhere will otherwise guess wrong.

3. **Partial-success response shape — this is the hard part of this slice, spend real design time here.** The spec's response body has a *required* `priorityApplied: boolean` field. `false` means every other field (name, budget, time budget, followers, worker) committed successfully, but the priority reorder specifically failed and the caller may retry just that field. This codebase has never had a partial-success write before — every prior write command (R09-R44) is all-or-nothing from the caller's perspective. The roadmap's suggestion (not a settled decision — actually decide this at /spec time): surface `priorityApplied: false` as a `notice` on an otherwise-success envelope, mirroring the refresh-GET-failed pattern from R10's decision 11 (spec 0020), rather than failing the whole command non-zero. Consider the alternative (non-zero exit with a distinguishable error/warning) and pick deliberately — this is exactly the kind of "new decision, not obviously covered by existing precedent" moment `autonomous-sdlc.md` expects you to log rather than rubber-stamp.

4. **`tracking_users_ids: []` clears all followers.** `should_change_existing_tasks: true` propagates the follower change to every existing task in the tasklist — a wide-blast-radius side effect on a command that isn't itself a delete. Give it its own explicit `--should-change-existing-tasks` opt-in flag (default false) rather than folding it silently into `--tracking-users`, and consider whether it deserves the same `--yes`/confirmation gating this CLI uses for destructive ops (R13 pattern) even though nothing is being deleted — the blast radius argument is about unexpected side effects reaching every task, not data loss per se. Decide and log.

5. **`worker_id: null` clears the default worker** — same "explicit null to clear" convention used elsewhere in this CLI (e.g. R10's `priority_enum: null`).

**Depends on:** R06 (`tasklists show`, same resource — look at its existing command file for structure/conventions), R13 (`src/lib/confirm.ts`, shared confirmation helper — see decision point 4 above for whether/how it applies here).

**Also, a repo-wide caution from recent sibling runs, unrelated to this feature but worth carrying:** do NOT touch, remove, or "clean up" `.claude/settings.json` under any circumstances — it's intentionally committed, shared project configuration (PR #109). If your working tree ever shows it modified/deleted, that's a staging mistake on your part, not a legitimate cleanup — stop and reconcile before committing. Also: MSW-backed tests in this repo's `test/msw/handlers.ts` sometimes invoke a resolver twice per logical request (confirmed repo-wide artifact, not a real double-request) — don't write or trust tests that assert exact request *counts*; assert request *content* instead (see M07's decision 6 for the precedent, `docs/decisions/2026-08-28-2039-files-delete-6-no-wire-level-request-count-assertions.md`).

Run parameters:
- allowNetwork: false (default)
- autoShip: false (default)
- Standard budgets (30 min wall clock, 40 agent calls, 8 retries, 25 files) — recent sibling runs on this repo have consistently run well over the 30-min wall-clock budget once calibration #3's full `pnpm test:cov` re-run on the committed tree is honored, and local parallel test runs on this machine have been unreliable under load (spurious timeouts/cross-test bleed that don't reproduce serially or in CI — see M07's and M08's run notes). Don't skip or shortcut the test-suite discipline to make the clock; if you hit flaky local failures, verify with a lower-parallelism or serial re-run before concluding there's a real regression, and let CI be the final word. If you run over budget, finish properly and log it as a decision rather than cutting corners.

This is a genuinely more complex slice than M01/M04/M07/M08 (a real design decision on the partial-success shape, plus a wide-blast-radius side-effect flag) — the roadmap slice guessed Yellow tier; confirm or override at triage based on what you actually find, and don't be surprised if this one's decision log is longer than the siblings'. Run through triage → spec → plan → implement → test → review → document → commit/push/PR → risk-tier gate. If Green with no blocking findings, let it auto-merge. If Yellow or a pause, stop and report — don't force it through. Report back the run outcome, tier, PR URL / merged SHA (or pause report), and specifically how you resolved the priorityApplied design question and the should-change-existing-tasks confirmation question.

## Budget caps in effect

| Resource | Cap |
|---|---|
| Wall clock | 30 min (soft — overrun to be logged as a decision, not shortcut) |
| Agent invocations | 40 |
| Phase retries | 8 |
| Files touched | 25 |

## Pre-flight verification (calibration #6)

- `git rev-parse --abbrev-ref HEAD` → `main`
- `git rev-parse HEAD` → `21ea9957947cc960f39f1184cf3a4621db10946e`
- `git rev-parse origin/main` → `21ea9957947cc960f39f1184cf3a4621db10946e` (identical, after `git fetch origin main`)
- `git status --short` → only untracked `.claude/settings.json` present in the pre-existing snapshot; **not to be touched, staged, or removed** (PR #109).
