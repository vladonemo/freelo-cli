# Triage — R44 notes + pins

**Run:** 2026-05-10-r44-notes-pins
**Tier:** Red (escalated from likely-Yellow during spec validation)
**Rationale:**

Initial intake suggested Yellow (8 new user-visible commands across 2 new top-level parents, 2 destructive ops, additive-only, no auth/HTTP-defaults change).

During the spec phase the orchestrator validated the requirement against `docs/api/freelo-api.yaml` (Calibration §1, never guess the API) and discovered material disagreements between the roadmap and the OpenAPI contract that **block the spec from being authored autonomously**. Per `autonomous-sdlc.md` "Autonomous decisions vs. pauses" → "API behavior not in `docs/api/freelo-api.yaml`" the run pauses for human resolution.

## Route flags
- `requiresFreeloApi`: true (API-touching surfaces)
- `needsSecurityReview`: false (no auth/secret/config touch)
- `preApprovedDeps`: [] (no new deps anticipated)

## Triggers
- New user-visible commands (additive) → Yellow
- Roadmap–OpenAPI disagreement on routes/verbs → escalates to Red (pause)
