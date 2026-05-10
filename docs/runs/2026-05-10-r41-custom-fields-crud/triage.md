# Triage — 2026-05-10-r41-custom-fields-crud

**Tier:** Yellow

**Rationale:**
- Four new user-visible commands (additive). One is destructive (`delete`).
- New envelope schemas: `freelo.custom-fields.{create,rename,delete,restore}/v1`.
- No auth / config / HTTP-defaults / release-tooling changes.
- No new dependencies.
- Reuses established patterns:
  - R40 wire wrappers + zod schemas + parent registrar.
  - R13 destructive-op helpers (`confirmDestructive`, batch, dry-run, idempotency).
  - R23 labels rename/delete (write-by-uuid; not by integer id — uuid is the closer analogue for R41 `delete`/`restore`/`rename`).

Per Yellow trigger list (`autonomous-sdlc.md` §Risk tiers):
- "New user-visible command or flag (additive)" → Yellow.
- "Changeset is `minor`" → Yellow.

No Red triggers fire:
- No touch on `src/config/`, auth flows, `src/api/client.ts`, TLS/retry/redirect.
- No envelope removal / rename / retype — all schemas brand new.
- No dep removal / major bump.

**Route flags:**
- `needsSecurityReview: false` — no secret handling, no new auth surface.
- `requiresFreeloApi: true` — four endpoints need OpenAPI confirmation + MSW handlers.
- `preApprovedDeps: []` — no new deps expected.

**Pre-flight discrepancy noted:**
- Roadmap says `PATCH /custom-field/rename/{uuid}`. OpenAPI spec
  `docs/api/freelo-api.yaml:4097-4136` says `POST`. The OpenAPI is
  authoritative per binding rules ("Spec says something the OpenAPI
  spec contradicts → Pause — Freelo's contract is authoritative").
  This is **not ambiguity** — the OpenAPI is unambiguous about the
  verb. Decision logged; implementation uses POST. Same precedent as
  spec 0035 (R23 labels rename) decision 01.

**Flow:** full pipeline → open PR → leave for human review and merge (no auto-merge).
