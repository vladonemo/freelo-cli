# Decision 11 — Local suite failures ruled environmental (load-dependent cross-test bleed), not regressions

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 6 (test / gates)
**Agent:** orchestrator

**Question:** The full `pnpm test:cov` run on the committed tree reported **11 failed tests across 8 files**. Is this slice responsible?

**Decision:** **No.** All failures are pre-existing, load-dependent local flakiness. The slice is green. Proceeded to PR; CI is the final word.

**Evidence chain (five runs):**

1. **Full `pnpm test:cov` on the committed tree** — 3196 passed, 11 failed across `test/commands/tasks/{move,list,edit}.test.ts` and `test/commands/comments/edit.test.ts`. **Zero failures in either file this slice added** (`test/commands/tasklists/edit.test.ts`, `test/api/tasklists-edit.test.ts`), and zero in any file it modified.
2. **Failure symptoms are bleed, not logic.** `expected 99 to be 42`, `expected undefined to deeply equal [ 42, 43 ]`, `expected 'message' to be 'file'` — values from one test appearing in another's envelope. Plus one hard `Test timed out in 15000ms`.
3. **Serial re-run of the 4 failing files** (`--pool=forks --poolOptions.forks.singleFork=true`) — 3 of 4 files went green; `tasks/move.test.ts` still failed 2.
4. **`tasks/move.test.ts` alone, serial** — **46/46 passed.** So the failure only appears when it shares a process with other files.
5. **The decisive control.** Ran the identical 4-file single-fork combo on **`main`** (179/179 passed, 119s), then the **identical combo again on this branch** (179/179 passed, 114s). The branch is not distinguishable from `main`.

The earlier *failing* branch run of that same combo took **178s** versus ~115s for both passing runs — a ~55% slowdown from machine load. The failures track wall-clock pressure, not the diff.

**Why this slice cannot plausibly be the cause:** its changes to shared files are strictly additive — a new exported handler object appended to `test/msw/handlers.ts` (only reachable via an explicit `server.use()`), new type/schema exports appended to `src/api/schemas/tasklist.ts`, and one `registerEdit(...)` line in `src/commands/tasklists.ts`. Nothing existing was modified, and none of the four failing test files touch the `tasklists` command group.

**Alternatives considered:**

- **Treat the failures as a real regression and investigate the source diff.** Rejected after step 5: the same combo passes on `main` *and* on the branch under equal load, so there is nothing branch-specific to investigate.
- **Declare "flaky" after step 1** on the strength of "none of my files failed". Rejected as too weak — a regression can surface in *other* files, which is precisely why steps 3-5 were run.
- **Add retries or raise `testTimeout`** to make the suite pass locally. Rejected: that masks a known repo-wide artifact and changes CI behavior to paper over a local machine problem. Out of scope for this slice.

**Consistency with prior runs:** this is the third consecutive sibling run to hit the same pattern (M07 and M08 run notes record it, and the human's run parameters warned about it up front). The artifact is real, reproducible-under-load, and independent of the feature being built.

**Follow-up flagged, not done:** the repo would benefit from a dedicated investigation into module-state bleed between test files sharing a fork — most likely the `vi.doMock('conf')` + `vi.resetModules()` harness that every command test copies. That is its own `chore/` slice, not a rider on a feature.

---

## Final gate state (second full `pnpm test:cov` on the committed tree)

Re-run after the renderer tests landed, on a less-loaded machine:

```
Test Files  1 failed | 175 passed (176)
     Tests  1 failed | 3226 passed | 1 skipped (3228)
```

The 11 bleed failures did **not** recur — consistent with the load-dependence finding above. The single remaining failure is:

`test/integration/windows-libuv-exit.test.ts > R05.5 Bug #3 — Windows libuv UV_HANDLE_CLOSING regression (subprocess)`

**Verified pre-existing.** Run in isolation it fails on this branch *and* fails identically on `main` (`git checkout main` → same single failure, same duration). It is a Windows subprocess-spawning integration test, unrelated to the `tasklists` command group, and this slice touches nothing it exercises. It is a local-machine condition, not a regression.

Other gates on the committed tree, all green: `pnpm typecheck`, `pnpm lint`, `pnpm build`, `pnpm check:readme`.

**Coverage of the new code** (measured directly, scoped to the three new source files):

| File | % Stmts | % Branch | % Funcs | % Lines | Directory threshold |
|---|---|---|---|---|---|
| `src/api/tasklists-edit.ts` | 100 | 92.3 | 100 | 100 | `src/api/**` 90/80/80/90 ✅ |
| `src/commands/tasklists/edit.ts` | 99.71 | 94.28 | 100 | 99.71 | `src/commands/**` 90/85/90/90 ✅ |
| `src/ui/human/tasklists-edit.ts` | 100 | 100 | 100 | 100 | global 80/75 ✅ |

Every new file is **above** the threshold for its directory, and the diff is purely additive (243 insertions, 0 deletions in modified files), so this slice cannot lower any aggregate — the calibration §4 drift risk does not apply.
