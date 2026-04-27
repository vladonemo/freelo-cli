# Requirement — R09 `freelo tasks create`

## Source
Roadmap slice R09 — first write command. Brings shared write infrastructure (`--dry-run`, `--stdin` NDJSON, batch streamer) reused by every later write slice.

## Outcome
Create a task in a tasklist, with workers, label, due date, description.

## Endpoint
`POST /project/{project_id}/tasklist/{tasklist_id}/tasks`

## CLI surface
```
freelo tasks create --tasklist <id> --name <str>
                    [--worker <id>]...
                    [--due YYYY-MM-DD]
                    [--priority low|normal|high]
                    [--label <name>]...
                    [--description <text>|--description-file <path>|--editor]
                    [--dry-run]

# Batch:
freelo tasks create --stdin --tasklist <id>   # NDJSON lines, one task per line
```

## Ships with this slice
- POST request schema + body builder pattern
- Shared write mixin: `src/lib/dry-run.ts`, `src/lib/batch.ts`
- NDJSON input reader + NDJSON output streamer
- Output schema: `freelo.tasks.create/v1`
- Dry-run carries `dry_run: true`; batch streams one envelope per input line

## Constraints (from invocation)
- allowNetwork: false (MSW only)
- autoShip: false
- Risk tier expected: Yellow
- Open PR and stop before merge for human review
- This is the first write command — design infra to be reused but minimal
- `--editor` may be deferred to R15 if appropriate (decide in spec, log decision, do not pause)
- Calibration §2: every typed error class needs an exit-code assertion test
- Calibration §4: each new try/catch arm needs a test
- Run all five gates on committed tree before push: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
- doc-writer must run `pnpm fix:readme`
- Add a changeset (minor bump)
- PR body must call out new envelope schema `freelo.tasks.create/v1`

## Run ID
`2026-04-27-tasks-create`

## Budgets
- 30 min wall clock
- 40 agent invocations
- 8 phase retries
- 25 files touched
