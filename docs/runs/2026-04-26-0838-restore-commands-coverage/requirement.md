# Requirement — restore commands branch coverage to ≥85%

## Run id
`2026-04-26-0838-restore-commands-coverage`

## Problem

CI on `main` is red because `pnpm test:cov` fails the per-directory threshold for `src/commands/**`:

```
ERROR: Coverage for branches (82.72%) does not meet "src/commands/**" threshold (85%)
```

Per-file gaps:

| File | Branches | Likely uncovered lines |
|---|---|---|
| `src/commands/projects/list.ts` | 81.15% | 315–316, 335, 339 |
| `src/commands/config/unset.ts` | 69.23% | 81, 89–111, 130 |
| `src/commands/config/resolve.ts` | 40% | 49, 63–64 |
| `src/commands/config/get.ts` | 69.23% | 58, 64–68, 79 |
| `src/commands/config/list.ts` | 66.66% | 42, 54–55 |

Root cause: PR #22 added `await drainDispatcher()` inside catch blocks across multiple command handlers; each `try/catch` wrap added new branches without corresponding tests.

## Goal

Add tests covering the new error-path branches in the five files above, raising aggregate `src/commands/**` branch coverage to ≥85%. All other thresholds must remain green.

## Hard scope boundaries

- No source-code changes under `src/`.
- No threshold changes in `vitest.config.ts`.
- No changesets (test-only).
- No README/doc changes.
- Don't touch `src/commands/auth/**`.

## Tier

Green (test-only additions; no surface, behavior, or schema change).

## Branch

`test/restore-commands-coverage` off `main` (`6065f80`).
