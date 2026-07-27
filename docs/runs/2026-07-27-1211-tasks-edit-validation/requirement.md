# Requirement — 2026-07-27-1211-tasks-edit-validation

**Source:** GitHub issue #105 — `bug: `tasks edit --name` fails with VALIDATION_ERROR on the POST /task/{id} response`
**Entry point:** `/auto` (autonomous SDLC)
**Base:** `main` @ `e033bd7` (v0.20.0), clean tree

## Verbatim summary

`freelo tasks edit <id> --name "<new name>"` fails with `VALIDATION_ERROR`
("Unexpected response shape from POST /task/<id>: <zod issues>") instead of applying
the rename. The request body builder looks correct; the failure is on response
validation in `src/api/tasks-edit.ts:89-99` where the `POST /task/{task_id}` response is
validated through `TaskDetailSchema` (`src/api/schemas/task.ts:349-376`). Throw site is
`src/api/client.ts:240-250`.

The issue ranks six hypotheses:

1. The response is not a bare `TaskDetail` / is wrapped
2. Numeric ids returned as strings
3. `state` returned as a bare string
4. `labels[]` missing `uuid`
5. `priority_enum` outside `l|m|h`
6. Partial / foreign `cost`

Blast radius: `TaskDetailSchema` also backs `tasks show`, `tasks move`, and the refresh
GET inside `tasks edit`.

**The issue explicitly states the real failing response body has NOT been captured.**

## Run constraints

| Constraint | Value |
|---|---|
| `allowNetwork` | `false` — no real Freelo API calls; cannot reproduce live |
| `autoShip` | `false` — never publish |
| Sources of API truth | `docs/api/freelo-api.yaml` + existing MSW fixtures only |
| Wall clock | 30 min |
| Agent calls | 40 |
| Retries | 8 |
| Files touched | 25 |

## Explicit judgment call demanded by the requirement

Decide honestly whether a correct fix is derivable without the raw body.

- Derivable (pin the divergence, or defensibly tolerant per the `MinutesSchema` /
  `CurrencySchema.amount` union-and-coerce precedent) → proceed + decision record.
- Would amount to guessing the API contract → **pause** with the structured report
  rather than shipping a speculative schema loosening.

A blanket `z.unknown()` bypass is not acceptable (CLAUDE.md: every network call stays
schema-validated). Do not widen the schema until the symptom disappears without a
defensible reason for each widened field.

## Process requirements (calibration log, binding)

- §1 run every phase including test, review, document
- §2 every spec-assigned exit code needs a test asserting it
- §3 gates run post-commit on the clean tree: `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`
- §4 every new try/catch arm needs a test
- §7 TTY-prompt tests must clear `process.env.CI`
- Regression tests go in the R10 `tasks edit` MSW suite with a verbatim real-world body
- Add a changeset (`patch` unless the envelope changes)
