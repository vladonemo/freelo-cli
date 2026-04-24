---
description: Phase 6 — write or update user docs for a change. Invokes the doc-writer agent.
argument-hint: <spec-path>
---

You are running **Phase 6 (Document)** of the SDLC defined in `.claude/docs/sdlc.md`.

Spec: $ARGUMENTS

## What to do

1. Read the spec and the implemented code so doc claims match reality.
2. Spawn the `doc-writer` agent to:
   - Create or update `docs/commands/<cmd>.md` for each new/changed command
   - Update `docs/getting-started.md` if the command is a likely first-stop
   - Refine help text in `src/commands/` for accuracy and tone
3. Verify each example in the new docs is a valid invocation (matches current flags).
4. Print the list of pages created/modified.

## Do not

- Document flags that don't exist.
- Duplicate `--help` output verbatim. Help is the source of truth; docs supplement.
- Add marketing copy — this is reference material.
