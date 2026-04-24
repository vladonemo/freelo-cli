---
description: Phase 4 — write or run tests. Invokes the test-writer agent when adding tests.
argument-hint: [spec-path | test-path | nothing to run full suite]
---

You are running **Phase 4 (Test)** of the SDLC defined in `.claude/docs/sdlc.md`.

Argument: $ARGUMENTS

## Behavior

- **No argument** → run the full test suite with coverage: `pnpm test --coverage`. Report failures and coverage vs. targets.
- **A spec path** → spawn `test-writer` to add tests for the change described in that spec, then run the suite.
- **A test path** → run just that file: `pnpm vitest run $ARGUMENTS`.

## Coverage targets

- 80% lines overall
- 90% on `src/api/` and `src/commands/`

Report the delta if coverage dropped.

## Do not

- Make real HTTP calls. MSW only.
- Silence failing tests. Fix them or surface the failure.
- Test library code (`commander`, `zod`). Test our code.
