## Paused at phase 1 (triage)

**Run:** 2026-04-27-R12.5-tasks-move-batch
**Reason:** R12.5 depends on R12 (`freelo tasks move <id>`); R12 is on open PR #50 (Yellow), not yet merged into `main`.
**Risk tier:** Red (unexpected block — pre-classified Yellow, but the dependency is missing from `main`)

### What happened

The orchestrator surveyed `main` for the R12 surface that R12.5 must extend. There is no `tasks move` command in `main` (`src/commands/tasks.ts` registers only `list / show / create / edit / finish / reopen`; no `src/commands/tasks/move.ts`, no `src/api/tasks-move.ts`, no `freelo.tasks.move/v1` envelope schema, no spec `0022-tasks-move.md`). R12 lives on the open PR **#50** (`feat/tasks-move`, head `d4a8ee1`) — all 7 CI checks green, but unmerged. The roadmap is explicit: "**Depends on: R12**" (`docs/roadmap.md` line 289), and dependency rule is "a slice may only depend on earlier-numbered slices" (line 30).

Proceeding now would either (a) write R12.5 against files that don't exist in `main` (instant typecheck failure), (b) duplicate R12's work in the R12.5 branch (one slice per PR violation), or (c) stack R12.5 on `feat/tasks-move` and violate calibration §6 ("inline mid-flow PRs must branch from `main`"). The autonomous flow has no path that doesn't require a human decision here.

### Evidence

- `git ls-files src/commands/tasks/` → no `move.ts`
- `src/commands/tasks.ts` lines 26–31 — `move` not registered
- `gh pr view 50 --json mergeStateStatus,statusCheckRollup` → all 7 checks `SUCCESS`, state `OPEN`
- `docs/roadmap.md` line 289: "Depends on: R12."
- `docs/roadmap.md` line 30: "Dependency rule: a slice may only depend on earlier-numbered slices."
- Triage detail: `docs/runs/2026-04-27-R12.5-tasks-move-batch/triage.md`

### Decision needed

Which sequencing path should the run take?

Options:
  A. **Merge PR #50 first, then re-run `/auto` for R12.5.** Cleanest. Respects Yellow human-gate and branch-from-`main` rules. Recommended.
  B. **Stack R12.5 on `feat/tasks-move`** (base = `feat/tasks-move`, not `main`). Violates the run config and calibration §6.
  C. **Bundle R12 + R12.5 into a single PR off `main`.** Discards PR #50; loses one-slice-per-PR.
  D. **Abort this run.** No progress, no waste.

### Resume with

```
/resume 2026-04-27-R12.5-tasks-move-batch A    # then merge PR #50 and rerun /auto
/resume 2026-04-27-R12.5-tasks-move-batch B
/resume 2026-04-27-R12.5-tasks-move-batch C
/resume 2026-04-27-R12.5-tasks-move-batch D
```
