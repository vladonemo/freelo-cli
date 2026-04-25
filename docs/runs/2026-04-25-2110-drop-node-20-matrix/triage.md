# Triage — 2026-04-25-2110-drop-node-20-matrix

**Tier:** Yellow

**Rationale:** Touches `.github/workflows/ci.yml` (CI matrix). Reduces
runtime-coverage of Node 20 (EOL 2026-04-30). No source code change, no public
surface change, no `engines.node` bump.

**Route flags:**

- `needsSecurityReview`: false
- `requiresFreeloApi`: false
- `preApprovedDeps`: []

**Pause-worthy events for this run:**

- Architect insists `engines.node` MUST be bumped (it must not — out of scope).
- Reducing matrix coverage causes any test failure (it shouldn't — tests are
  runtime-agnostic).
