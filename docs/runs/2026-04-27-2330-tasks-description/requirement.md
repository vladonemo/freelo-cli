# Requirement — R15: `freelo tasks description` (get/set)

Source: `docs/roadmap.md` lines 317–327.

**Outcome:** Get or replace a task's rich description from the terminal.

**Endpoints:**
- `GET /task/{task_id}/description`
- `POST /task/{task_id}/description` (upsert — same endpoint creates or replaces)

**CLI surface:**
- `freelo tasks description get <id>`
- `freelo tasks description set <id> (--from-file <path> | --editor | -)` where `-` means read from stdin

**Depends on:** R09 (`tasks create`) — already shipped.

**Notable:** First command introducing the editor / stdin / `--from-file` input shared helper at
`src/lib/input.ts` per the cross-cutting concerns table in `docs/roadmap.md` (line 686). Build the
helper as part of this slice — generic and reusable; future commands (R17 `comments add`, etc.) will
reuse it.

## Run parameters

- allowNetwork: false (MSW only)
- autoShip: false
- Budgets: defaults (30 min · 40 calls · 8 retries · 25 files)
- Run ID: 2026-04-27-2330-tasks-description
- Branch: feat/tasks-description
