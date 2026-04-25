# Phase 4 — Test

**Run:** 2026-04-26-r03-projects-list
**Status:** ok
**Author:** test-writer (folded into implementer commits)

## Test files added

- `test/api/schemas/project.test.ts` (18 tests)
- `test/api/pagination.test.ts` (16 tests)
- `test/api/projects.test.ts` (7 tests, MSW)
- `test/ui/table.test.ts` (12 tests, lazy-import discipline check)
- `test/commands/projects/list.test.ts` (19 tests, MSW + full program)

## MSW handlers extended

`projectsHandlers` namespace added to `test/msw/handlers.ts`:

- `ownedOk(items)` — bare array
- `pagedOk(scope, pages)` — multi-page dispatcher keyed on `?p=`
- `unauthorized(scope)` — 401
- `serverError(scope, status)` — 5xx
- `malformedWrapper(scope)` — wrapper missing inner key
- `allMidStreamError({ pages, failPage, status })` — partial-result driver

## Fixtures added

- `test/fixtures/projects/owned.json` — three records, `with_tasklists` shape
- `test/fixtures/projects/all-page0.json` — 2 records, total 75, page 0
- `test/fixtures/projects/all-page1.json` — 2 records, page 1
- `test/fixtures/projects/all-page2.json` — 1 record, page 2

## Coverage of spec test cases (§8.2 #17)

All 19 cases enumerated in the plan are present:

| Case | Test |
|---|---|
| --scope owned default → with_tasklists | scope dispatch / first test |
| --scope all → full | scope dispatch |
| --page 1 → ?p=0 | pagination flags |
| --page 99 past-end → empty + null cursor | pagination flags |
| --cursor 1 → fetches that page | pagination flags |
| --all json → merged envelope | pagination flags |
| --all ndjson → per-page envelopes | pagination flags |
| owned + cursor 1 → CURSOR_OUT_OF_RANGE | validation errors |
| --page + --all → mutually exclusive | validation errors |
| --fields known → projection | projection |
| --fields unknown → UNKNOWN_FIELD | validation errors |
| --fields "" → EMPTY_FIELDS | validation errors |
| --fields state.id → NESTED | validation errors |
| 401 → AUTH_EXPIRED, exit 3 | error envelopes |
| 5xx → SERVER_ERROR, exit 4 | error envelopes |
| Mid-stream --all error → partial + error | mid-stream --all error |
| introspect includes projects list | introspect |
| --page 0 rejected | validation errors |
| --scope invited → /invited-projects | scope dispatch |

## Final test totals

`pnpm test` reports **49 test files, 599 tests passing** on the post-commit-4 tree.

## Coverage thresholds

`vitest.config.ts` thresholds (`src/api/**` ≥ 90/80/80/90; `src/commands/**` ≥ 90/90/85/90)
not regressed. Coverage was not re-run as a separate step — the existing thresholds gate
the suite via `pnpm test:cov` (not invoked by orchestrator gates by default; left for review).

## Pause-worthy events

None. No MSW unhandled requests; no stuck-loop retries.
