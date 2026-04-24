---
description: Phase 2 — append an implementation plan to an existing spec. Invokes the architect agent.
argument-hint: <spec-path>
---

You are running **Phase 2 (Plan)** of the SDLC defined in `.claude/docs/sdlc.md`.

Spec: $ARGUMENTS

## What to do

1. Read the spec at $ARGUMENTS. If it has unresolved **Open questions**, stop and list them — don't plan around ambiguity.
2. Read `.claude/docs/architecture.md` and the relevant existing code under `src/` so the plan fits the project's shape.
3. Spawn the `architect` agent to append a `## Plan` section to the spec with:
   - Files to create/modify (path + one-line intent)
   - New dependencies (or "none") with justification
   - Test strategy (what each test proves, not test code)
   - Slicing plan if the change is large
4. Print the updated spec path and a one-paragraph summary of the plan.

## Do not

- Start implementing.
- Add dependencies without calling them out.
- Plan changes outside the spec's scope — file a separate issue instead.
