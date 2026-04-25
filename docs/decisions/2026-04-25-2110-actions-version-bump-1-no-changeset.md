# Decision 1 — No changeset for action-version bump

**Run:** 2026-04-25-2110-actions-version-bump
**Phase:** Implement (resume)
**Agent:** orchestrator

**Question:** Does bumping `actions/checkout`, `actions/setup-node`, and `pnpm/action-setup` from `@v4` to `@v5` in `.github/workflows/{ci,release}.yml` warrant a changeset entry?

**Decision:** No changeset.

**Alternatives considered:**
- Add a `patch` changeset noting "internal CI hardening" — would be visible in CHANGELOG.md and bump the npm version.
- Add a `none` changeset (empty entry) — preserves the audit trail in `.changeset/` without bumping the version.

**Rationale:** The change touches only `.github/workflows/*` files. Nothing in the published npm tarball changes (workflows are not packed). No consumer-visible behavior changes: not commands, flags, envelopes, exit codes, dependencies, or the `engines` field. Per `CLAUDE.md` working agreements, "every user-visible change needs a changeset entry" — this is not user-visible. The PR body itself is sufficient audit trail for a CI-internal chore.
