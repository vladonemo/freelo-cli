---
description: Phase 5 — pre-PR self review against the plan and conventions. Invokes the code-reviewer agent.
allowed-tools: Bash(git diff:*), Bash(git log:*), Bash(pnpm:*), Read, Glob, Grep
---

You are running **Phase 5 (Review)** of the SDLC defined in `.claude/docs/sdlc.md`.

## What to do

1. Determine the branch base (usually `main`). Run `git diff main...HEAD --stat` to scope the review.
2. Locate the relevant spec under `docs/specs/` (the branch name should match the spec slug).
3. Spawn the `code-reviewer` agent with:
   - The diff range
   - The spec path
   - Pointers to `.claude/docs/conventions.md` and `.claude/docs/architecture.md`
4. If the diff touches `src/config/` or auth flows, also run `/security-review` — or include the `security-auditor` agent in parallel.
5. Present the findings grouped as **Blocking / Non-blocking / Looks good**.

## Do not

- Apply fixes automatically. The reviewer reports; a human or the implementer decides.
- Open a PR until blocking findings are resolved.
