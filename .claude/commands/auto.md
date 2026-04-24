---
description: Autonomous mode — run the full SDLC pipeline end-to-end on a requirement. Invokes the orchestrator agent. Gated by risk tiers defined in .claude/docs/autonomous-sdlc.md.
argument-hint: <requirement | issue-number> [--budget-minutes N] [--allow-network] [--ship]
---

You are running the **autonomous SDLC** defined in `.claude/docs/autonomous-sdlc.md`.

Input: $ARGUMENTS

## What to do

1. Read `.claude/docs/autonomous-sdlc.md` and `.claude/docs/sdlc.md` — both are binding.
2. Parse $ARGUMENTS:
   - If it starts with `#` or is all digits, treat as a GitHub issue: `gh issue view <n>` for the body.
   - Otherwise treat as a free-text requirement.
   - Extract optional flags: `--budget-minutes`, `--allow-network`, `--ship`.
3. Spawn the `orchestrator` agent with:
   - The requirement text
   - The budget overrides (if any)
   - The `allowNetwork` flag (default: false — MSW only)
   - The `autoShip` flag (default: false — never publish unless explicit)
4. Stream the orchestrator's progress lines to the user as they happen.
5. When the orchestrator returns:
   - **Success (Green auto-merged)**: print the summary + PR URL + merged SHA.
   - **Success (Yellow PR open)**: print the summary + PR URL, tell the human to review.
   - **Paused**: print `pause.md` verbatim and the exact `/resume` command to continue.
   - **Aborted**: print why, the run directory, and any partial branch.

## Pre-flight checks (before invoking orchestrator)

- `git status` is clean (no uncommitted changes that would muddy the new branch). If not, stop and say so.
- `main` is up to date (`git fetch && git status` shows no behind). If behind, pull first.
- `pnpm install` has run and the lockfile is current (no "would be changed" from a dry run).

Any pre-flight failure → don't start. Report the issue.

## Hard rules

- **Never pass `--ship` implicitly.** It must be an explicit flag from the user.
- **Never bypass pre-flight checks.** A dirty working tree is never OK for an autonomous run.
- **The run is non-destructive on abort.** Work stays on its branch. Never `git reset` or delete without explicit instruction.
- **If the orchestrator pauses, you stop too.** The user drives resumption via `/resume`.

## Output format

```
/auto started — run <run-id>
  requirement: <short>
  tier (pending triage)
  budget: <mins>m · <N> calls · <R> retries

[live progress lines from the orchestrator]

<final summary or pause report>
```
