# Triage — 2026-04-26-0747-drop-keytar

**Tier:** Yellow
**Rationale:** Touches `src/config/credentials.ts` and the `auth login`/`auth logout` flows
— normally a Red trigger per `autonomous-sdlc.md` §"Risk tiers" (Red: "Touches `src/config/`,
auth flows"). Mitigants:

- The user has explicitly authorized scope, the migration story, and the changeset bump.
- The change is a *removal* (drop keytar tier), not a redesign of the auth flow.
- The recommended path (env vars) is unchanged.
- The fallback path (tokens.json @ 0600) is unchanged on its hot path; it just becomes the
  *only* persistent path.

Per the user's pre-authorization, the orchestrator marks this Yellow. If, during spec or
implementation, evidence emerges that the change is bigger than scoped (e.g. a transitive
dep forces keytar back), pause and re-tier.

**Route flags:**
- `needsSecurityReview: true` — touches credential storage; `security-auditor` runs after
  `code-reviewer`.
- `requiresFreeloApi: false` — no API surface changes.
- `preApprovedDeps: []` — this run *removes* a dep (`keytar`) and its transitive
  `prebuild-install`. No additions.

**Branch:** `chore/drop-keytar`
**Auto-merge:** enabled on green CI (Yellow + zero Critical security findings).
