# Pause — 2026-04-25-2110-actions-version-bump

**Phase:** Implement
**Reason:** Concurrent-run conflict on `.github/workflows/ci.yml`

## What happened

Mid-implementation the working tree was changed out from under this run:

- `.github/workflows/ci.yml` — my `@v4 → @v5` bumps for `actions/checkout`,
  `actions/setup-node`, `pnpm/action-setup` were **reverted to `@v4`**.
- The same file gained a matrix change `node: [20, 22, 24] → node: [22, 24]`,
  which is the deliverable of a **parallel autonomous run**:
  `docs/runs/2026-04-25-2110-drop-node-20-matrix/`
  (spec `docs/specs/0007-drop-node-20-from-matrix.md`).
- `.github/workflows/release.yml` still carries my `@v4 → @v5` bumps
  (untouched by the parallel run).

Both runs claim spec number `0007`. The parallel run's spec explicitly
acknowledges the collision risk in its Risks section ("Possible merge conflict
with the parallel `actions-version-bump` run on the same file. Trivially
three-way mergeable").

## Why I'm pausing instead of "trivially merging"

The orchestrator's hard rules forbid speculation on user intent when the
working tree changes mid-run. Three plausible intents, each leading to a
different commit:

1. **"Take both"** — the matrix change AND the action bumps land together in a
   single CI-only chore PR.
2. **"This run owns release.yml only"** — the parallel run already covers
   ci.yml; this run scopes down to release.yml only and ships the action bumps
   there. ci.yml stays on `@v4` until the parallel run merges, then a follow-up
   bumps ci.yml separately.
3. **"Cancel this run"** — the user prefers to fold the action bumps into the
   parallel run (or a third unified run) and abort this one.

Picking any of these unilaterally either steps on the parallel run, leaves
release.yml inconsistent with ci.yml, or wastes the spec/triage already
written.

## Current branch state

```
branch:    chore/bump-gha-actions (off main @ 581bd46)
modified:  .github/workflows/ci.yml      (matrix + @v4 retained — parallel run's work)
           .github/workflows/release.yml (@v5 bumps — this run's work)
untracked: docs/specs/0007-bump-gha-actions-node24.md
           docs/runs/2026-04-25-2110-actions-version-bump/
```

Nothing has been committed or pushed.

## What I need to know

Pick one:

- **A.** Take both — I commit ci.yml (matrix + `@v5` bumps) AND release.yml
  (`@v5` bumps) in one PR titled `chore(ci): bump actions to v5 and drop Node 20`
  and abort the parallel run.
- **B.** Scope down — I commit only `release.yml` here (action bumps), revert
  my ci.yml staged work, and let the parallel run land its matrix-only PR.
  A follow-up run bumps ci.yml after.
- **C.** Abort — discard this run; fold action bumps into the parallel
  `drop-node-20-matrix` run or open a fresh combined run.

## Verified upstream facts (preserve regardless of choice)

- `actions/checkout@v5.0.0` (2025-08-11) is on Node 24. `v6.0.0` also Node 24.
- `actions/setup-node@v5.0.0` (2025-09-04) is on Node 24. `v6.0.0` also Node 24.
- `pnpm/action-setup@v5.0.0` (2026-03-17) is on Node 24. `v6.0.3` (2026-04-21)
  also Node 24 with pnpm v11 RC support.
- All input surfaces we use (`fetch-depth`, `node-version`, `cache: pnpm`,
  `registry-url`, `version`, `run_install`) are byte-identical across v4→v5.
- `actions/setup-node@v5` introduces auto-detection of `packageManager`; we
  pass `cache: pnpm` explicitly so the explicit value wins. Verified safe.

Resume with `/resume 2026-04-25-2110-actions-version-bump <A|B|C>`.
