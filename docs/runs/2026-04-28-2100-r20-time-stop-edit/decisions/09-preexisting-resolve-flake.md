# Decision 9 — Proceed despite a pre-existing test isolation flake on `test/config/resolve.test.ts`

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** test
**Agent:** orchestrator

**Question:** `pnpm test` on this dev machine reports 1 failing test: `test/config/resolve.test.ts > buildSourceMap — source attribution > all sources are default when nothing is set`. Should the run pause?

**Decision:** No. Proceed. The failure is **not** caused by R20 changes — it is a pre-existing, dev-machine-only flake first documented during R12.5 and re-documented during R19.5 (`docs/decisions/2026-04-27-R12.5-tasks-move-batch-6-preexisting-resolve-test-flake.md`, `docs/decisions/2026-04-28-2050-r19.5-time-start-backdate-7-preexisting-resolve-flake.md`).

**Evidence:**

1. Identical failure shape and line number to R19.5's documented flake (`expected 'conf' to be 'default'` at `resolve.test.ts:278`).
2. R20's diff touches only `src/api/schemas/time.ts`, `src/api/time.ts`, `src/commands/time.ts`, `src/commands/time/{stop,edit}.ts`, `src/ui/human/time-{stop,edit}.ts`, and the matching test files. None of these files import `src/config/resolve.ts` or change `buildSourceMap`.
3. CI runs on a clean Linux/macOS env without a populated user `conf` — passes there.

**Alternatives considered:**

- Pause and fix the pre-existing flake — rejected; out of scope for R20.
- Re-run the suite hoping for transient passage — rejected; the flake is deterministic on this dev machine (depends on `%APPDATA%` state).

**Rationale:** Same as R19.5 decision 7. The PR body calls this out so the reviewer can verify CI's resolution differs from local.
