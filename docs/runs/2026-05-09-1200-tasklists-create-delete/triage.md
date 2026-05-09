# Triage — R34

**Run:** 2026-05-09-1200-tasklists-create-delete
**Tier:** Yellow

## Rationale

- Three new user-visible commands (`tasklists create`, `tasklists delete`, `tasklists create-from-template`).
- Three new envelope schemas (`freelo.tasklists.create/v1`, `freelo.tasklists.delete/v1`, `freelo.tasklists.create-from-template/v1`).
- One destructive command (`delete`) — uses existing `confirmDestructive` helper; not a new pattern.
- Additive only — no breaking changes; minor changeset.
- No new runtime dependencies expected.
- No touch on `src/config/`, auth, HTTP client defaults, or release tooling.

## Route flags

- `needsSecurityReview`: false (no auth surface, no new secret storage; reuses existing patterns)
- `requiresFreeloApi`: true (need OpenAPI schema for all three endpoints — must verify body fields)
- `preApprovedDeps`: [] (no new deps allowed without a pause)

## Pre-flight

- Branch from `main` at `bf79ae3` (current HEAD).
- Reuse: `confirmDestructive` (R13), `idempotency.ts` (R11), `dry-run.ts` (R09), existing tasklists command group (R05/R06).
- Bind to Calibration §3 amendment: `pnpm build` directly before `fix:readme`/`check:readme`.
