# Phase 4 — Test

**Artifacts:** `test/commands/task-labels/find.test.ts` (19 tests), `test/msw/handlers.ts` (+7 factories on the existing `taskLabelsHandlers`).
**Result:** 19/19 pass. **Retries: 1** (see below).

## Coverage on the new code

| File | Stmts | Branch | Funcs | Lines |
|---|---|---|---|---|
| `src/commands/task-labels/find.ts` | 98.57 | 82.35 | 100 | 98.57 |
| `src/ui/human/task-labels-find.ts` | 100 | 100 | 100 | 100 |
| `src/api/task-labels.ts` | 100 | 100 | 100 | 100 |
| `src/api/schemas/task-label.ts` | 100 | 100 | 100 | 100 |

The single uncovered line in `find.ts` is the closing brace after `handleTopLevelError`, which never returns. Same shape as every sibling command.

## Calibration §2 — exit-code assertions

Every typed error class the spec assigns a code has at least one test asserting it: `ValidationError` 2 (three flag-parse arms: `abc`, `0`, `-5`), `FreeloApiError` 3 (401) and 4 (5xx **and** malformed body), `NetworkError` 5, `RateLimitedError` 6.

Calibration §7 does not apply — this command has no `isInteractive()`-gated TTY-prompt path. The human-output tests go through `--output human`, not TTY detection, so there's no `CI` env var to clear.

## The one retry — and why it wasn't a code bug

Two tests initially asserted `expect(seen).toHaveLength(1)` on a capturing MSW handler and got **2**.

Rather than adjust the number, I checked whether the command was genuinely double-requesting. `src/api/client.ts`'s `attempt` loop issues exactly one `fetch` and only re-attempts on 429 — so a 200 response can't produce two. I then reproduced the same doubling against the **pre-existing** `freelo labels list` path with a throwaway capturing handler: 2 there too, on code this run never touched.

Conclusion: an MSW/undici test-harness artifact, not a property of this command. Rewrote both tests to assert that *every* captured request carries the right pathname and query string, dropping the count assertion — see decision 6. That still guards the thing worth guarding (that `/task-labels/find-available` and not the `/project-labels/find-available` sibling is being called), without hard-coding harness behavior into an assertion. The `toHaveLength(0)` assertions in the flag-validation tests are kept, since "no request at all" is a real property of the command.

Flagged as a follow-up candidate: GET resolvers firing twice silently doubles the request count in every MSW-backed GET test in the repo. Out of scope here.

## Spec correction found by testing

The spec's edge-case table assigned exit **2** to a malformed response body. Actual behavior is exit **4** (`FreeloApiError` / `VALIDATION_ERROR`), matching `src/api/client.ts` and the sibling test at `test/commands/labels/list.test.ts:234-242`. The spec was my own drafting error; corrected in §5 rather than bending the code to match it — exit 2 is for user-controlled input, exit 4 for a server-side fault. Decision 7.
