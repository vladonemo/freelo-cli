# Requirement — 2026-08-25-1037-task-labels-find

**Source:** `docs/roadmap-migration-2026-08.md` § M04 (merged to `main` in PR #112)
**Invoked:** autonomous run, branching from `main` (`01a26a9`)
**Run parameters:** `allowNetwork: false`, `autoShip: false`; standard budgets (30 min wall clock, 40 agent calls, 8 retries, 25 files)

## Original input

> **M04 — `freelo task-labels find`**, from `docs/roadmap-migration-2026-08.md` (merged to main in PR #112).
>
> **Endpoint:** `GET /task-labels/find-available` — newly documented in `docs/api/freelo-api.yaml` (refreshed in PR #112). This closes a gap `.claude/skills/freelo-api/SKILL.md`'s "Known quirks" section has flagged since the original R24 (task-labels) work: there was no reliable bulk-list / name-to-uuid resolver for task-labels. **Important distinction, don't confuse the two:** this is `/task-labels/find-available` (plural, task-level labels), a *different, newly-added* endpoint from the pre-existing `/project-labels/find-available` (project-level labels) that R23 already covers — SKILL.md's existing quirk note about `find-available` returning empty results is about the *project-labels* one, not this new task-labels one.
>
> **Behavior notes from the roadmap slice** (verify against the actual spec text at `docs/api/freelo-api.yaml` when you spec this — search for `findAvailableTaskLabels`):
> - Results sorted by `name` ascending.
> - Optional `project_id` query param restricts to labels used in that one project — must be a project the caller can access, otherwise the response is `{ "labels": [] }`, not an error.
> - If the caller has no accessible projects at all, also `{ "labels": [] }`, not an error. Treat both cases as a legitimate empty result in the CLI, not a failure path.
>
> **CLI shape:** `freelo task-labels find [--project <id>]` — lists all task labels usable by the caller (id/uuid/name/color). This is a new read-only subcommand on the existing `task-labels` parent command. Look at the existing `src/commands/task-labels/` directory (R24, already shipped — e.g. `attach.ts`) for the parent-command structure, envelope conventions, and how existing task-labels commands are wired, before designing this one so it's consistent.
>
> This is a **new read-only command, no writes, no destructive ops** — the roadmap slice guessed Green tier for this reason, but the two sibling runs today (M01, M08) both came back Yellow on grounds that surprised their own roadmap-slice guesses (new user-visible surface, minor changeset). Confirm the real tier at triage rather than assuming Green — don't force a tier either direction.
>
> Run through triage → spec → plan → implement → test → review → document → commit/push/PR → risk-tier gate. If Green with no blocking findings, let it auto-merge. If Yellow or a pause, stop and report.

## Sequence context

Third and last of three runs (M01 → M08 → M04). Prior two are open PRs #113 and #114 awaiting human review. This run does not depend on either merging first.

## Budget note carried in from the sibling runs

The 30-minute wall-clock budget has proven hard to hit on this repo once calibration #3's full `pnpm test:cov` re-run on the committed tree is honored (one sibling run alone took ~11 min for that gate). Instruction was explicit: do not skip or shortcut that gate to stay under budget — run over and log it as a decision instead.
