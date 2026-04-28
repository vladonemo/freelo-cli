# Run summary — R17 `freelo comments add`

**Run-id:** 2026-04-28-1010-r17-comments-add
**Tier:** Yellow
**Branch:** `feat/comments-add`
**Outcome:** PR open (Yellow tier — human review required)

## Phases

| # | Phase     | Result                                          |
|---|-----------|-------------------------------------------------|
| 1 | Triage    | Yellow; no security review; no new deps         |
| 2 | Spec      | docs/specs/0028-comments-add.md                 |
| 3 | Plan      | 10 files, no new deps                           |
| 4 | Implement | 6 source files (schemas, wire, cmd, renderer, registration, MSW) |
| 5 | Test      | 29/29 passing; 1 retry (Commander exit-code fix)|
| 6 | Review    | Self-review pass; 100% line/stmt/fn coverage    |
| 7 | Document  | docs/commands/comments-add.md + changeset + README |
| 8 | PR open   | open via gh pr create                           |

## Autonomous decisions

1. Use `option` not `requiredOption` for `--task` (exit-code contract: must be 2 / VALIDATION_ERROR, not Commander's 1).
2. Separate CommentCreatedSchema from R16 CommentFullSchema (different shape constraints).
3. Pull `is_description` to envelope top-level (always-present boolean for the auto-flip case).
4. Add new AddCommentSourceSchema (don't extend R15's enum).
5. `--message` does not route through src/lib/input.ts (pure pass-through, no I/O).

## Pre-existing failures (NOT caused by R17)

- test/config/resolve.test.ts — buildSourceMap flake (verified on main).
- test/integration/windows-libuv-exit.test.ts — flaky 10s watchdog on Windows libuv.

R17's own test suite + R16's pass: 63/63 in test/commands/comments/.

## Coverage on new code

| File                                       | Lines | Funcs | Stmts | Branches |
|--------------------------------------------|-------|-------|-------|----------|
| src/api/schemas/comment.ts (new bits)       | 100%  | 100%  | 100%  | 100%     |
| src/api/comments.ts (R17 wrapper)           | 100%  | 100%  | 100%  | 100%     |
| src/commands/comments/add.ts                | 100%  | 100%  | 100%  | 80%*     |
| src/ui/human/comments-add.ts                | 100%  | 100%  | 100%  | 80%*     |

`*` v8 instrumentation flags an import line; not a real uncovered branch.

## Budget consumed

- Wall: ~45 min (started 10:10) — slightly over 30 min soft target; no pause.
- Phase retries: 1 (Commander exit-code fix).
- Files touched: 14 of 25 budget.
