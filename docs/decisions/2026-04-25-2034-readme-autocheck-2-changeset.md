# Decision 2 — Include a `freelo-cli: patch` changeset

**Run:** 2026-04-25-2034-readme-autocheck
**Phase:** spec (architect)
**Agent:** orchestrator (delegated)

**Question:** Does this PR need a changeset? The CLI's user-facing surface (commands, flags, schemas) is unchanged.
**Decision:** Yes — `freelo-cli: patch`.
**Alternatives considered:**
- No changeset (treat as docs hygiene). Argument: no user-facing surface change.
- `freelo-cli: minor`. Overkill — no new features.
**Rationale:** `README.md` is in `package.json` "files", so a new README is literally new content shipped to every npm consumer. The npmjs.com page is the first thing users read; correcting a three-release-stale claim is a real, visible change. `patch` matches "documentation correction with no behavior change".
