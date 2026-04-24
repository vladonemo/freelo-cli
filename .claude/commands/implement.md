---
description: Phase 3 — implement a planned spec. Invokes the implementer agent.
argument-hint: <spec-path>
---

You are running **Phase 3 (Implement)** of the SDLC defined in `.claude/docs/sdlc.md`.

Spec: $ARGUMENTS

## What to do

1. Read the spec. Verify it has a `## Plan` section (Phase 2 complete) and no unresolved **Open questions**. If either fails, stop.
2. Create or switch to a branch named `<type>/<slug>` matching the spec.
3. Spawn the `implementer` agent with the spec path. It executes the plan, commits in Conventional Commits style, and creates a changeset if user-visible.
4. After it returns, run `pnpm lint && pnpm typecheck && pnpm test` — report any failures.
5. Do **not** run `/review` or `/ship` automatically. Print the next-step command for the user.

## Do not

- Deviate from the plan. If blocked, the implementer updates Open questions and stops.
- Skip git hooks or `--amend` a rejected commit.
- Add dependencies not listed in the plan.
