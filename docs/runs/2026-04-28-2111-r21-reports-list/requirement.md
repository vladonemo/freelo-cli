# Requirement — R21 `freelo reports list`

Source: `docs/roadmap.md` §R21.

## Verbatim

### R21 — `freelo reports list`

**Outcome:** Browse work reports (time entries) with filters.
**Endpoints:** `GET /work-reports`, `GET /task/{task_id}/work-reports`.
**CLI:** `freelo reports list [--task <id>] [--project <id>] [--worker <id>] [--from DATE] [--to DATE] [--page N|--all]`.
**Depends on:** R07.

## Configuration

- autoShip: false
- allowNetwork: false
- budgetMinutes: 30
- budgetCalls: 40
- budgetRetries: 8
