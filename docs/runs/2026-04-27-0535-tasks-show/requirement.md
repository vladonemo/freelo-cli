# Requirement — R08 `freelo tasks show <id>`

## Source
`docs/roadmap.md` §R08 (Wave 1 — Read-only essentials).

## Outcome
Full task view: metadata, description, subtasks, labels.

## Endpoints
- `GET /task/{task_id}` — base task
- `GET /task/{task_id}/description` — rich description (lazy-load via `--with description`)
- `GET /task/{task_id}/subtasks` — subtasks list (lazy-load via `--with subtasks`)
- `GET /task/{task_id}/projects` — multi-project membership (lazy-load via `--with projects`)

## CLI surface
```
freelo tasks show <id> [--with description,subtasks,projects]
```

## Depends on
R07 (already shipped — `feat(commands): add 'freelo tasks list'` at d124392, released as 0.11.0).

## Run config
- run-id: `2026-04-27-0535-tasks-show`
- branch: `feat/tasks-show`
- schema: `freelo.tasks.show/v1`
- budgets: 30 min · 40 calls · 8 retries · 25 files
- allowNetwork: false (MSW only)
- autoShip: false (PR-open at most)

## References (well-trodden patterns)
- R04 — `projects show` (spec 0013) — `--with workers` expansion, the canonical pattern
- R06 — `tasklists show` (spec 0016) — `--with assignable-workers`, refines the pattern

## Hard rules (carried from invocation)
- Read-only slice → expected risk tier **Green**.
- Calibration Log §1–§6 must be honored: don't skip test phase, exit-code assertions on every error path, gates on the committed tree, test new try/catch arms, branch base hygiene.
- Changeset entry required (minor).
- `pnpm fix:readme` must run after the command lands.
