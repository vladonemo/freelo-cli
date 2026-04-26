# Phase 3 — Implement

**Run:** 2026-04-26-1537-r05-tasklists-list
**Phase:** implement
**Agent:** orchestrator (implementer role)
**Status:** ok

---

## Files produced

| Path | Lines | Notes |
|---|---|---|
| `src/api/schemas/tasklist.ts` | ~85 | TasklistFullSchema + TasklistListDataSchema + TASKLIST_DEFAULT_FIELDS |
| `src/api/tasklists.ts` | ~45 | `getAllTasklists()` wrapper |
| `src/commands/tasklists.ts` | ~20 | Parent command (no meta) |
| `src/commands/tasklists/list.ts` | ~290 | Leaf command. Parser uses `ValidationError` (NOT `InvalidArgumentError`) per Calibration §1-2. |
| `src/ui/human/tasklists-list.ts` | ~75 | Table renderer with `project.name` and `state.state` summarisation |
| `src/bin/freelo.ts` | +2 | `registerTasklists` import + call |
| `README.md` | regen | autogen Commands block updated via `pnpm fix:readme` |

## Files produced for tests + docs

| Path | Notes |
|---|---|
| `test/msw/handlers.ts` | Added `tasklistsHandlers = { allOk, allByProject, unauthorized, notFound, serverError, malformedWrapper, allMidStreamError }` |
| `test/fixtures/tasklists/all-page0.json` | 3 items, total=7, per_page=3 |
| `test/fixtures/tasklists/all-page1.json` | 3 items |
| `test/fixtures/tasklists/all-page2.json` | 1 item, last page |
| `test/fixtures/tasklists/project-42-page0.json` | 2 items, scoped |
| `test/api/tasklists.test.ts` | 6 tests (api wrapper unit-level) |
| `test/commands/tasklists/list.test.ts` | 29 tests (full E2E) |
| `docs/commands/tasklists-list.md` | User-facing doc with two examples + permissions note |
| `docs/getting-started.md` | One-line cross-link |
| `.changeset/r05-tasklists-list.md` | minor bump, mentions new envelope schema |

## Calibration discipline checks

- **§1 (don't skip phases):** All phases run before push.
- **§2 (exit-code assertions):** Every typed error class has at least one test asserting `exitCode`. `ValidationError` (exit 2): 11 tests. `FreeloApiError` (exit 4): 4 tests. AUTH_EXPIRED (exit 3): 1 test. SERVER_ERROR (exit 4): 2 tests.
- **§3 (gates on committed tree):** Will run after each commit, before push.
- **§4 (catch arms tested):** New `try/catch` blocks are in `src/commands/tasklists/list.ts` action wrapper and `runAll`'s `PartialPagesError` handler. Both arms covered: tests #24 (first-page error, no PartialPagesError) and #25 (mid-stream, PartialPagesError handled). Plus generic top-level catch covered by all the validation/HTTP error tests.

## Coverage results (excluding pre-existing `test/config/resolve.test.ts` failure)

| Path | Lines | Branches |
|---|---|---|
| `src/api/tasklists.ts` | 100% | 100% |
| `src/api/schemas/tasklist.ts` | 100% | 100% |
| `src/commands/tasklists.ts` | 100% | 100% |
| `src/commands/tasklists/list.ts` | 98.02% | 84.37% |
| `src/api/**` aggregate | 95.79% lines | 80.41% branches (above 80% threshold) |
| `src/commands/**` aggregate | passes |
| Overall test:cov | exit 0 |

## Pre-existing test failure

`test/config/resolve.test.ts > buildSourceMap — source attribution > all sources are default` fails locally on Windows but passes in CI (verified — main's CI runs are green). The failure pre-dates R05 (reproduced on a clean `git stash` of the working tree). The test reads the real `conf` store and picks up an existing user config on this dev machine; CI runs in a clean environment.

**Decision:** Do not fix in R05. Pre-existing, environment-specific, out of scope. Documented as a follow-up cleanup candidate.

## Commit slicing (planned)

Per spec §8.6:

1. **C1** — `feat(api): add tasklist schema and getAllTasklists wrapper` — files in `src/api/schemas/`, `src/api/`.
2. **C2** — `feat(commands): add tasklists list subcommand (R05)` — `src/commands/tasklists.ts`, `src/commands/tasklists/list.ts`, `src/ui/human/tasklists-list.ts`, `src/bin/freelo.ts`, `README.md`.
3. **C3** — `test(commands): cover tasklists list (R05)` — fixtures, MSW handlers, both test files.
4. **C4** — `docs(commands): document tasklists list (R05)` — docs + getting-started + changeset.

## Next phase

Phase 4 (test) was rolled into the implement phase since the spec mandates test coverage as a gate. Phase 5 (review) is a brief pass; Phase 6 (document) is already done; Phase 7 (commit + push + PR).
