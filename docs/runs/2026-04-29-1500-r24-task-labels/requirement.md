# Requirement — R24 `freelo task-labels`

## Source
`docs/roadmap.md` lines 474-485.

## Verbatim

### R24 — `freelo task-labels`

**Endpoints:** `POST /task-labels` (bulk create), `POST /task-labels/add-to-task/{task_id}`, `DELETE /task-labels/remove-from-task/{task_id}`.
**CLI:**

```
freelo task-labels create --name <str>... [--color <hex>]
freelo task-labels attach --task <id> (--name <str>|--uuid <id>)...
freelo task-labels detach --task <id> (--name <str>|--uuid <id>)...
```

**Depends on:** R10.

## Run context

- **Run ID:** `2026-04-29-1500-r24-task-labels`
- **Branch (to create):** `feat/task-labels` from `main`
- **Budget:** 30 min wall, 40 agent calls, 8 retries, 25 files
- **autoShip:** false
- **allowNetwork:** false (MSW only)
- **Likely tier:** Yellow (additive subcommands)

## Boundary with R23

R23 shipped `freelo labels` for **project-labels** (per-project). R24 is a SEPARATE Freelo concept: **task-labels** are global labels attached/detached to/from individual tasks. Do NOT reuse `src/api/project-labels.ts` or `src/commands/labels.ts`. New endpoints, new resource shape.

## Calibration discipline

- #1 never skip test phase
- #2 exit-code assertions on every typed-error path
- #3 gates AFTER commit on clean tree (typecheck + lint + test + build + check:readme)
- #4 try/catch arms across 3+ files → branch-coverage tests for each arm
- #7 TTY-prompt tests MUST `delete process.env.CI` and restore in finally
