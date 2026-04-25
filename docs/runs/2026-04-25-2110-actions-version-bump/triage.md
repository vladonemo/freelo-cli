# Triage — 2026-04-25-2110-actions-version-bump

**Tier:** Yellow (compressed — CI-only chore)

**Rationale:** Touches `.github/workflows/*.yml` only. No source code, no tests, no public surface change. CI is the test. Yellow because workflow changes can in principle break the release pipeline, so a human still glances at the PR before auto-merge lands.

**Route flags:**
- `needsSecurityReview`: false (no auth/secret/network surface change)
- `requiresFreeloApi`: false
- `preApprovedDeps`: [] (no npm dep changes; only pinned action versions)
- `changeset`: **not required** — workflow changes don't affect the published `freelo-cli` artifact

**Budget:** default (30 min, 40 calls, 8 retries, 25 files).
