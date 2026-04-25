# Decision 1 — Defer `engines.node` bump from this run

**Run:** 2026-04-25-2110-drop-node-20-matrix
**Phase:** Spec / Plan
**Agent:** orchestrator (architect role)

**Question:** When dropping Node 20 from the CI matrix, should we also bump
`package.json` `engines.node` from `">=20.11.0"` to `">=22"`?

**Decision:** No. Preserve `engines.node: ">=20.11.0"` in this PR. The engines
bump is deferred to a separate, deliberate release.

**Alternatives considered:**

- Bump in this PR. Rejected: it is a user-visible, semver-relevant change
  (anyone on Node 20 LTS would see install-time `EBADENGINE` warnings or — with
  strict-engines configurations — install failures) and deserves its own
  changeset, its own changelog callout, and its own clear semver decision
  (minor with a deprecation note vs. major).
- Bump in this PR but only as `engines.node: ">=20"` → `">=20.11.0"` no-op
  rephrasing. Rejected: doesn't address the question and is pure noise.

**Rationale:** CI-matrix coverage and runtime-engine declaration are
independent concerns. Internal CI choices reflect what we routinely verify;
`engines.node` is a contract with installers and downstream tooling. Coupling
them in one PR mixes a chore with a public-API change and skips a deliberate
semver decision. The next minor or major release can revisit the engines field
on its own merits.

# Decision 2 — No changeset for this PR

**Run:** 2026-04-25-2110-drop-node-20-matrix
**Phase:** Plan
**Agent:** orchestrator (architect role)

**Question:** Should this PR include a changeset entry?

**Decision:** No. CI-matrix coverage is internal-only; consumers of `freelo-cli`
on npm are unaffected. The `engines.node` field — the public surface that
declares supported runtimes — is unchanged.

**Alternatives considered:**

- `freelo-cli: patch` with a one-line "CI no longer tests against Node 20"
  note. Rejected: this is operational housekeeping, not a user-visible
  behavioral change. Adding a changeset would also generate a release line that
  conflates the internal change with the (separate, future) engines bump.

**Rationale:** Changesets describe behavior or surface deltas users see. CI
configuration changes do not qualify. The PR body and the README's CI badge
already convey the matrix change to anyone reading the repo directly.
