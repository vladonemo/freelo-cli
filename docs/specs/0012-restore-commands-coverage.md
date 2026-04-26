# Spec 0012 — Restore `src/commands/**` branch coverage to ≥85%

**Status:** in progress
**Tier:** Green
**Run:** `2026-04-26-0838-restore-commands-coverage`
**Branch:** `test/restore-commands-coverage`

## Problem

CI on `main` is red: `pnpm test:cov` aggregate branch coverage for `src/commands/**` is **82.72%**, below the configured **85%** threshold (`vitest.config.ts:38`). All 611 tests pass — only the threshold gate fails.

Per-file gaps (from the failing run on `main` @ `6065f80`):

| File | Branches | Uncovered lines |
|---|---|---|
| `src/commands/projects/list.ts` | 81.15% | 315–316, 335, 339 |
| `src/commands/config/unset.ts` | 69.23% | 81, 89–111, 130 |
| `src/commands/config/resolve.ts` | 40% | 49, 63–64 |
| `src/commands/config/get.ts` | 69.23% | 58, 64–68, 79 |
| `src/commands/config/list.ts` | 66.66% | 42, 54–55 |

Root cause: PR #22 (`a24f462`) added `await drainDispatcher()` cleanup paths inside catch blocks across multiple command handlers. Each `try/catch` wrap added new branches without corresponding tests. The merge unblocked a real bug but pushed the threshold over the edge.

PR #25 (Version Packages → `0.6.0`) is open and waiting for `main` to go green so 0.6.0 can ship.

## Proposal

Test-only additions. **No source-code changes.** Add focused tests that exercise the missing branches in each of the five files. Keep tests small (one `it()` per branch).

Per file:

### `src/commands/config/resolve.ts`
- Line 49: `readStore()` throws → email defaults to `''`. Mock `conf.store` to throw. (Already isolated test machinery in `test/commands/config/resolve.test.ts`.)
- Lines 63–64: outer `catch (err)` → `handleTopLevelError` path. Force an unhandled error inside the action body (e.g. `hasToken` throws via spy).

### `src/commands/config/get.ts`
- Line 58: same pattern as resolve — `readStore()` throws → email defaults to `null`.
- Lines 64–68: defensive `!entry` ValidationError (a key passed `isKnownKey` but `buildConfigListData` did not list it). This branch is structurally unreachable with the current `keys.ts` catalog — pause-worthy on its own. **Decision:** skip this dead branch; cover the other branches and rely on the aggregate to come back ≥85%. If we still fall short, revisit.
- Line 79: outer catch — same pattern as resolve.

### `src/commands/config/list.ts`
- Line 42: `readStore()` throws → email defaults to `null` then `''`.
- Lines 54–55: outer catch — same pattern.

### `src/commands/config/unset.ts`
- Line 81: `verbose` default coerce-to-string branch (`writableKey === 'verbose' && typeof prev === 'number'`). Pre-populate `defaults.verbose: 2` and unset.
- Lines 89–91 (scope === 'currentProfile'): unset `profile` key when `currentProfile` is set → `removed: true`.
- Lines 92 (scope === 'currentProfile' idempotent path): unset `profile` when `currentProfile === null` → `removed: false`.
- Lines 94–110 (scope === 'profile'): unset `apiBaseUrl` when active profile exists → resets to `API_BASE_DEFAULT`.
- Line 97–101 (missing-profile error): unset `apiBaseUrl` when `store.profiles[currentProfileName]` is missing → `ConfigError(missing-profile)`.
- Line 130: outer catch — implicitly exercised by the missing-profile case above (ConfigError flows through the catch).

### `src/commands/projects/list.ts`
- Line 315: `--all` first-page failure → fetchAllPages re-throws underlying error (no `PartialPagesError` because no successful pages yet).
- Line 335: success path with `lastRaw === undefined` — structurally unreachable when `fetchAllPages` completes successfully (it always sets `lastRaw` at least once). **Skip** as defensive code.
- Line 339: human-mode `--all` rendering branch (currently no human-mode --all test). Add a `--scope all --all` test in `--output human` (with TTY=false to avoid prompts) that verifies exit 0 and no error envelope.

## API surface
None — test-only.

## Data model
None — existing fixtures and MSW handlers.

## Edge cases targeted
- `readStore()` throwing on a fresh install (corrupt or missing conf file).
- Outer top-level catch flowing structured errors to `handleTopLevelError`.
- `unset profile` and `unset apiBaseUrl` paths previously untested.
- `unset` for verbose number → string coercion.
- Missing profile when unsetting `apiBaseUrl` (ConfigError path).
- `--all` failing on the very first page (no PartialPagesError).
- Human-mode rendering of `projects list --all`.

## Non-goals
- No refactoring of any source under `src/`.
- No threshold change in `vitest.config.ts`.
- No changeset (test-only, no version bump).
- No README or doc changes.
- No new test infrastructure (reuse existing `vi.doMock('conf')` pattern + MSW).
- Do not touch `src/commands/auth/**` (already at 91.8%).

## Open questions
None.

---

## §8 Plan

Single commit: `test(commands): restore branch coverage to ≥85%`.

### Files modified
1. `test/commands/config/resolve.test.ts` — add 2 tests (readStore throws, outer catch).
2. `test/commands/config/get.test.ts` — add 2 tests (readStore throws, outer catch).
3. `test/commands/config/list.test.ts` — add 2 tests (readStore throws, outer catch).
4. `test/commands/config/unset.test.ts` — add 5 tests (verbose coerce, profile unset, profile idempotent, apiBaseUrl unset, missing profile).
5. `test/commands/projects/list.test.ts` — add 2 tests (first-page error, human mode --all).

Total: ~13 new test cases. No source change. No new dependency.

### Verification
After commit, on the committed tree:
```
pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme
```
All five must pass. Specifically `pnpm test:cov` must show `src/commands/**` aggregate branches ≥ 85%.

If after one retry threshold still missed → pause per `.claude/docs/autonomous-sdlc.md`.

### Conventional Commit
`test(commands): restore branch coverage to ≥85%` — scope `commands` is on the allow-list.
