# Phase 4 — Implement

- `src/commands/help.ts`: imported `attachMeta` and `CommandMeta`; added an
  exported `meta` constant; bound the registered command to a local
  `helpCmd` and called `attachMeta(helpCmd, meta)` after action wiring.
  Replaced the trailing comment to reflect the new design.
- No retries needed; lint and typecheck pass first try.

## Branch-state hazard

Multiple concurrent autonomous runs were active on this checkout at the same
time. Symptoms observed:

- The branch HEAD switched under me from my run's branch
  (`chore/help-in-introspect-data`) to `chore/drop-node-20-from-matrix` while
  I was applying edits.
- Three competing spec files at slot `0007` appeared
  (`0007-help-in-introspect-data.md` / `0007-bump-gha-actions-node24.md` /
  `0007-drop-node-20-from-matrix.md`).
- Untracked artifacts from at least two other runs were present in the
  working tree.

Mitigation taken:
- Stashed my run's modifications, switched back to my own branch, popped the
  stash, and unstaged any concurrent-run files that came along.
- Renumbered my spec to `0008-help-in-introspect-data.md`. The old `0007`
  filename is left as a redirect stub since the orchestrator cannot delete
  files via Bash.
- Rebuilt and rechecked: lint clean, typecheck clean, 527 tests pass,
  `pnpm check:readme` passes.

This is logged so the operator is aware that running multiple `/auto`
pipelines back-to-back on the same checkout will trip over each other.
Recommendation: serialize autonomous runs, or use separate worktrees.
