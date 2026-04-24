---
description: Phase 1 — produce a spec for a new feature or change. Invokes the architect + freelo-api-specialist agents.
argument-hint: <issue-number-or-description>
---

You are running **Phase 1 (Discover/Specify)** of the SDLC defined in `.claude/docs/sdlc.md`.

Input: $ARGUMENTS

## What to do

1. If $ARGUMENTS is an issue number, fetch it via `gh issue view`. Otherwise treat it as a free-form description.
2. Spawn the `architect` agent with full context: the request, the relevant existing code, and a pointer to `.claude/docs/sdlc.md` Phase 1 for the spec format.
3. If the work involves the Freelo API, spawn `freelo-api-specialist` in parallel to produce the API-surface section.
4. Consolidate their output into `docs/specs/NNNN-<slug>.md` where NNNN is the next unused four-digit number.
5. Print the spec path and a one-paragraph summary. Flag any **Open questions** that need the human before Phase 2.

## Do not

- Write implementation code.
- Commit the spec until the human has reviewed it.
- Guess at Freelo API behavior — if unknown, it belongs in Open questions.
