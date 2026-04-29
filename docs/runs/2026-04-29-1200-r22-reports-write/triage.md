# Triage — R22 reports write

**Run:** 2026-04-29-1200-r22-reports-write
**Decided by:** orchestrator (delegated triage scope)
**Tier:** **Yellow**

## Rationale

R22 ships three new user-visible commands (`reports log`, `reports edit`, `reports delete`):

- New commands → Yellow trigger ("New user-visible command or flag (additive)").
- New envelope schemas (`freelo.reports.log/v1`, `freelo.reports.edit/v1`, `freelo.reports.delete/v1`) — additive, not breaking.
- One destructive command (`reports delete`) — reuses existing `src/lib/confirm.ts` and `src/lib/idempotency.ts` (no new auth/HTTP/config surface).
- Changeset is `minor`.

No Red triggers:
- Does not touch `src/config/`, auth, `src/api/client.ts`, TLS/retry/redirect defaults.
- No breaking change.
- No dependency removal or major bump.
- Spec has one Open question (verb divergence — see below) → orchestrator pauses per invocation directive, not per Red-tier rule. After resolution, proceed as Yellow.

## Route flags

- `needsSecurityReview`: **false** (no auth/secret-handling surface change; idempotency keys are non-secret; reuses scrub helper for note/cost passthrough).
- `requiresFreeloApi`: **true** (binds against `docs/api/freelo-api.yaml` for three endpoints).
- `preApprovedDeps`: `[]` — no new dependencies expected. The conditional "money helper" is in-tree (`src/lib/money.ts`) if needed, not a new package.

## Pause trigger

Per invocation directive ("If any of those contradict the roadmap line, **pause** and document the divergence, do not silently re-route"), the spec phase verb-binding revealed the roadmap's `PATCH /work-reports/{id}` does not match `docs/api/freelo-api.yaml` (verb is `POST`). Pausing before spec is finalized. See `pause.md`.
