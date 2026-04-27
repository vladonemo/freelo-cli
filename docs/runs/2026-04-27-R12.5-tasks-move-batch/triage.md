# Triage — R12.5 `freelo tasks move` batch input

**Run:** 2026-04-27-R12.5-tasks-move-batch
**Tier:** Red (unexpected — pre-classified Yellow, but blocked on a Yellow dependency that has not landed)
**Decision:** Pause before spec.

## Rationale

The roadmap pre-classifies R12.5 as Yellow on its own merits (additive surface, minor changeset, touches the cross-cutting `src/lib/batch.ts`). That classification stands for the slice itself.

However, **R12.5 explicitly `Depends on: R12`** (`docs/roadmap.md` line 289) and the entire R12.5 problem statement is framed as "closes the only remaining gap between `tasks move` and the rest of the write surface that already supports batch" — i.e. it assumes `freelo tasks move <id>` already exists in `main`.

Current state of `main` (commit `5197ca6`):
- No `src/commands/tasks/move.ts`.
- No `src/api/tasks-move.ts`.
- No `freelo.tasks.move/v1` envelope schema.
- No `docs/specs/0022-tasks-move.md`.
- `src/commands/tasks.ts` registers only `list / show / create / edit / finish / reopen` — no `move`.

R12 lives on the open PR **#50** (`feat/tasks-move`, head commit `d4a8ee1`):
- Title: `feat(commands): r12 — `freelo tasks move <id>` to relocate tasks across tasklists/projects`
- Tier: Yellow
- All 7 CI checks green (Node 22/24 × Ubuntu/macOS/Windows + check README autogen)
- `mergeable: UNKNOWN`, but checks are green and no reviews block
- Ships the spec (`0022-tasks-move.md`), envelope schema, single-id command, and the idempotency wiring R12.5 needs to extend.

## Why this triggers Red

Per `.claude/docs/autonomous-sdlc.md`:
- "**Plan drift: implementer needs files not in plan** → Pause — plan is the contract."
- "Dependency rule: a slice may only depend on earlier-numbered slices." (`docs/roadmap.md` line 30)
- The Yellow tier of R12 means it requires a human gate before merge. The orchestrator cannot autonomously merge a Yellow PR (that is the entire point of the Yellow tier).

If we proceeded:
1. We would have to either (a) duplicate R12's work into the R12.5 branch (violates "one slice per PR"), (b) stack R12.5 on top of R12's branch (violates "branch from current `main`"), or (c) write R12.5 against files that don't exist in `main` (will fail typecheck, lint, and tests immediately).
2. Any of those routes burns the budget without producing reviewable output.

## Decision needed from human

This is a sequencing call, not a UX call.

### Options

**A. Merge PR #50 first, then re-run `/auto` for R12.5.**
- Tradeoff: cleanest. R12.5 starts from a clean `main` that has `tasks move <id>` available. Both PRs land in the order the roadmap specifies.
- Cost: one human action (review + merge PR #50) and a fresh `/auto` invocation.

**B. Stack R12.5 on top of `feat/tasks-move`** (base branch = `feat/tasks-move`, not `main`).
- Tradeoff: R12.5 PR shows the diff against R12, not against `main`. Reviewer needs to read both PRs in sequence; rebase headaches if R12 changes during review.
- Cost: workable, but violates the run config in this invocation (which says "branch from current `main`, already synced and clean") and is contrary to calibration §6 ("inline mid-flow PRs must branch from `main`").

**C. Bundle R12 + R12.5 into a single PR off `main`.**
- Tradeoff: ships both slices as one commit chain. Loses the "one slice per PR" property and makes R12.5's change to `src/lib/batch.ts` harder to isolate from R12's wiring.
- Cost: rewrites R12's history into a new branch; the existing PR #50 becomes redundant.

**D. Abort this run.**
- Tradeoff: R12.5 goes back to the queue until R12 lands.
- Cost: no progress made, but no waste either — only triage was run.

### Recommendation

**Option A.** It's the only one that respects both the "Yellow needs human gate" rule and the "branch from `main`" rule. PR #50's CI is fully green; merging it is the single human action this pause is asking for.

## Resume with

```
/resume 2026-04-27-R12.5-tasks-move-batch A    # then merge PR #50 and rerun /auto
/resume 2026-04-27-R12.5-tasks-move-batch B    # I'll stack on feat/tasks-move
/resume 2026-04-27-R12.5-tasks-move-batch C    # I'll combine R12 + R12.5 into one PR
/resume 2026-04-27-R12.5-tasks-move-batch D    # abort
```
