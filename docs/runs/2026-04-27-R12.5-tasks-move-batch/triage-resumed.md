# Triage (resumed) — R12.5 `freelo tasks move` batch input

**Run:** 2026-04-27-R12.5-tasks-move-batch
**Resumed:** 2026-04-27 (answer A — merge PR #50 first)
**Tier:** Yellow (re-triaged after dependency cleared)

## Dependency state on resume

- `main` HEAD: `6d28ecf feat(commands): r12 — \`freelo tasks move <id>\``
- PR #50 merged at 2026-04-27T17:04:40Z (squash). All R12 surface present.
- Working tree: clean.

## R12 surface available in `main`

Files referenced in spec 0022:
- `src/commands/tasks/move.ts` — single-id command (Commander leaf, `runMove(...)` orchestration).
- `src/api/tasks-move.ts` — `moveTask`, `movePath` wire wrappers.
- `src/api/schemas/task.ts` — `TasksMoveDataSchema`, `TasksMoveData` (lines 702-719).
- `src/ui/human/tasks-move.ts` — four shapes (live, idempotent, dry-run, dry-run skipped).
- `test/commands/tasks/move.test.ts` + four fixtures + `tasksMoveHandlers` in `test/msw/handlers.ts`.
- `docs/specs/0022-tasks-move.md` — R12 spec.
- `docs/commands/tasks-move.md` — R12 user docs.

## R12.5 tier: Yellow (confirmed)

Triggers (per `.claude/docs/autonomous-sdlc.md`):
- New user-visible flag (`--stdin`, optionally `--pairs`) on an existing command — additive.
- No envelope schema change (`freelo.tasks.move/v1` unchanged; reuse).
- Touches `src/lib/batch.ts` — cross-cutting, but additive (extension, not breaking).
- No `src/config/`, auth, `src/api/client.ts`, TLS/retry/redirect changes.
- No new dependencies.
- Changeset is `minor` (new flag).

Yellow: full pipeline → open PR → stop before merge.

## Route flags

- `requiresFreeloApi`: false — endpoint shape unchanged from R12; OpenAPI already documented.
- `needsSecurityReview`: false — no auth or config touched.
- `preApprovedDeps`: [] — no new deps expected.
- `expectedFilesTouched`: ~6-9 (`src/commands/tasks/move.ts`, `src/lib/batch.ts`, `src/ui/human/tasks-move.ts` (per-line shapes), tests, fixtures, docs, changeset, README autogen).

## Open questions deferred to spec phase

Per the run config defaults:
1. `--pairs` sugar — default to **stdin-only**.
2. Failure semantics — default to **continue-on-error**.
3. `--to-project` global vs per-row — default to **per-row only**.

The architect agent will validate these against R09 (`tasks create --stdin`) and R11
(`tasks finish --stdin`) precedent and lock the answers in autonomous decisions.

## Pre-approved decisions (no pause needed)

- Internal naming, file naming, zod shape for the per-line schema, helper extraction shape
  in `src/lib/batch.ts`.
- Whether `--stdin` reuses positional `[id...]` (R11 pattern) or stays standalone (R09
  pattern). Pre-vote: **standalone** because per-line shape is `{id, to_tasklist, ...}`
  with two ids, not just an id list.

## Next phase

Phase 2 (spec) — extend spec 0022 OR write new spec 0023 for R12.5. Recommend new spec
(0023) so R12 history stays self-contained; R12.5 references back to 0022.
