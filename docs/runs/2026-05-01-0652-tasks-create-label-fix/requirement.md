# Requirement

Run autonomous SDLC pipeline for spec `docs/specs/0041-tasks-create-label-fix.md`
(merged via PR #77, sha `71e6627`).

## Mode and policy

- allowNetwork: false (MSW only)
- autoShip: false (never invoke /ship)
- Budgets: defaults from .claude/docs/autonomous-sdlc.md

## Pipeline entry

Phase 1 (Spec) is complete. Pick up at Phase 2 (Plan).

Strategy locked: Option A (decompose into create-then-attach via
`POST /task-labels/add-to-task/{newId}`). Schema bumps `freelo.tasks.create/v1`
→ `freelo.tasks.create/v2`. Target version `v0.17.2 (patch)`. Skip
`security-auditor` (no auth/config/HTTP-defaults touched).

## Spec-locked items (do not re-litigate)

- Single batched attach call (one HTTP per task, not N).
- Partial-failure (create OK + attach fail): exit 4, success-shaped envelope on
  stdout, `freelo.error/v1` on stderr.
- Out of scope: `tasks edit --label`, `task-labels attach --name`.
