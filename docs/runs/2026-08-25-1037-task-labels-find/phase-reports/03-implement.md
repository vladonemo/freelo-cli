# Phase 3 — Implement

**Retries:** 0. `pnpm lint` and `pnpm typecheck` both passed on the first run.

## Files

| File | Change |
|---|---|
| `src/api/schemas/task-label.ts` | +`TaskLabelSchema`, `FindAvailableTaskLabelsResponseSchema`, `TaskLabelsFindDataSchema`. Appended below the R24 block; nothing existing touched. |
| `src/api/task-labels.ts` | +`FIND_AVAILABLE_TASK_LABELS_PATH`, `findAvailableTaskLabelsPath()`, `findAvailableTaskLabels()`. First `GET` in the module — docblock updated from three endpoints to four. |
| `src/commands/task-labels/find.ts` | **new** — the leaf. |
| `src/commands/task-labels.ts` | +`registerFind`; docblock "Three leaves" → four. |
| `src/ui/human/task-labels-find.ts` | **new** — `UUID | NAME | COLOR` table, lazy `cli-table3` via `renderTable`. |

No deviation from the plan; no new dependencies.

## Notes

- `SchemaString` is a template-literal type (`` `freelo.${string}/v${number}` ``), so `freelo.task_labels.find/v1` needed no registration anywhere.
- `buildQuery` handles the single optional param: `undefined` → empty string → bare path with no `?`. That's what makes the "no `--project` sends no query string at all" test meaningful rather than incidental.
- `parseProjectIdFlag` throws `ValidationError`, **not** Commander's `InvalidArgumentError` — the exact bug calibration §2 was written about (`InvalidArgumentError` exits 1, the contract wants 2).
- Response schema is `.passthrough()` with `.nullable().optional()` leaves per the permissive-schema policy, but the outer `labels` key is **required**: an empty array is valid data, a missing key is a contract violation that should fail loudly.
- Per calibration §4, the diff adds exactly **one** new `catch (` arm (the leaf's `handleTopLevelError` wrapper). It is driven four separate ways by the error-path tests, so it doesn't introduce an untested branch.
