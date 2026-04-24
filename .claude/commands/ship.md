---
description: Phase 7 — drive a release to npm. Invokes the release-manager agent.
allowed-tools: Bash(git:*), Bash(pnpm:*), Bash(gh:*), Read, Edit
---

You are running **Phase 7 (Ship)** of the SDLC defined in `.claude/docs/sdlc.md`.

## What to do

1. Verify `main` is green: `gh run list --branch main --limit 1` must show a passing CI run.
2. Check for unmerged security fixes — if any are pending, stop.
3. Spawn the `release-manager` agent to:
   - Ensure every user-visible PR merged since the last tag has a changeset
   - Review or open the Version Packages PR
   - After merge, confirm the npm publish ran and the tag exists
4. Post-release smoke test: `npx freelo-cli@latest --version` and `--help`.
5. Print: version shipped, top-3 changes, npm and GitHub Release URLs.

## Do not

- Publish from a local machine. CI only.
- Bypass the Version Packages PR — even for hotfixes.
- `npm unpublish`. Use `npm deprecate` if a bad version shipped.
