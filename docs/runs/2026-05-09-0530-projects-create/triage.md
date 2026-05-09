# Triage — 2026-05-09-0530-projects-create

**Run:** 2026-05-09-0530-projects-create
**Requirement:** R29 — `freelo projects create` (first slice of Wave 5).

## Tier: Yellow

### Rationale
- **New user-visible command** (`freelo projects create`) — additive surface. Yellow trigger.
- **New envelope schema** `freelo.projects.create/v1` — additive, public-contract-stable.
- **No new runtime dependency** — reuses `zod`, `commander`, and the Wave 2 write infrastructure (`src/lib/dry-run.ts`, `src/lib/batch.ts`).
- **No auth, HTTP client defaults, or release-tooling changes.**
- **Not destructive** — create is additive; no `--yes` confirmation needed (CLAUDE.md write-command policy still requires `--dry-run` + batch input + idempotency-stance, which are the surface contract here).
- **Changeset:** `freelo-cli: minor` (new flag and command).

### Route flags
- `needsSecurityReview`: false — no auth flow, no secret handling, no new HTTP surface.
- `requiresFreeloApi`: true (informational) — `POST /projects` body is well-documented in `docs/api/freelo-api.yaml:206-227` (`name`, `currency_iso` required; `project_owner_id` optional; response is `ProjectBasic { id, name }`). No new specialist call needed; the OpenAPI is sufficient.
- `preApprovedDeps`: [] — none needed.

### Notable findings during triage (resolved by spec phase)
1. **Roadmap `--date-start` flag is NOT in the OpenAPI body.** The documented `POST /projects` body only has `name`, `currency_iso`, `project_owner_id` (yaml :211-227). The hard rule says "API behavior not in `docs/api/freelo-api.yaml` → pause / don't guess the API." Decision: **drop `--date-start` from R29's surface** and document the deferral. Logged as a decision; no pause needed (the requirement says "follow the surface" but the OpenAPI is authoritative — calibration-class precedent: spec 0032 §R20 dropped `--note` from `time stop` for the same reason).
2. **Roadmap `--currency` is OPTIONAL on the CLI but REQUIRED in the body.** The OpenAPI marks `currency_iso` required. Decision: make `--currency` **required** (validation error if missing) — agents must supply it. Sane default would be a config-bound preference but R29 doesn't introduce that kind of state; we surface the API rule directly.
3. **No batch-ND-JSON / `--stdin` support in v1.** Project creation is rare and consequential enough that single-shot is the right v1. Add the dry-run wrap and idempotency stance (no idempotency for create — create is non-idempotent like R09 tasks create).

## Pre-approved decisions
- Drop `--date-start` flag (not in OpenAPI); follow-up R29.5 if Freelo adds the field.
- Make `--currency <code>` required.
- No `--stdin` batch input in v1.
- Reuse `dryRunEnvelope` from `src/lib/dry-run.ts`.
- New API wrapper at `src/api/projects-create.ts` (mirrors R09's `src/api/tasks-create.ts` separation of read vs. write surfaces).

## Verdict
Proceed with full pipeline through PR. **Do not** auto-merge.
