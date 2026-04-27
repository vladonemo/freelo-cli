# R11 — `freelo tasks finish` / `tasks reopen`

## Run config
- Mode: autonomous
- allowNetwork: false (MSW only)
- autoShip: false
- Budgets: defaults (30 min wall, 40 agent calls, 8 retries, 25 files)

## Outcome
State transitions from the terminal. First absorbing-state writes — introduces the shared idempotency handler.

## Endpoints
- `POST /task/{task_id}/finish`
- `POST /task/{task_id}/activate`

## CLI surface
```
freelo tasks finish <id>... [--dry-run]
freelo tasks reopen <id>... [--dry-run]
freelo tasks finish --ids a,b,c                # batch
freelo tasks finish --stdin                    # NDJSON in, NDJSON out
```

## Ships with this slice
- `src/lib/idempotency.ts` — helper detecting "already in target state" responses (or pre-checking state) and returning a success envelope with `already_in_target_state: true`. Reused by archive, activate, mark-read/unread, attach/detach-label, delete-by-id.
- Output schemas: `freelo.tasks.finish/v1`, `freelo.tasks.reopen/v1`.

## Depends on
R09 (write infra: `src/lib/dry-run.ts`, `src/lib/batch.ts`, NDJSON streamer — already shipped).

## Risk tier guidance
Almost certainly Yellow (new user-visible command surface adding new envelopes). Would only become Red if the spec discovers ambiguity, breaking schema change, or touches `src/api/client.ts`/`src/config/`.
