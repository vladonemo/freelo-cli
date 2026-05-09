# Triage — R33 `freelo projects invite`

**Run:** 2026-05-09-r33-projects-invite
**Tier:** **Yellow**
**Branch type:** `feat`
**Slug:** `projects-invite`

## Rationale

- New user-visible command (additive sub-leaf under `projects`).
- Adds a new envelope schema `freelo.projects.invite/v1` (additive — no removal/rename).
- Changeset: `minor` (new flag-set / command).
- No touches to `src/config/`, `src/api/client.ts`, auth flows, TLS, retry, or release tooling.
- No new runtime dependencies (reuses R32 patterns: confirmDestructive — though `invite` is non-destructive, no idempotency, no batch in v1).
- Security auditor: not triggered (no auth / config / secret-handling changes).

## Route flags

- `requiresFreeloApi: true` — `POST /users/manage-workers` schema must be verified against `docs/api/freelo-api.yaml`.
- `needsSecurityReview: false`.
- `preApprovedDeps: []` — no new deps allowed without pause.

## OpenAPI verification (orchestrator pre-spec)

Verified against `docs/api/freelo-api.yaml` :3417-3498:

- Path: `POST /users/manage-workers` ✓
- Summary: "Invite users (by email or ID) to one or more projects" — "invite" verb is correct, no reframing needed.
- Body shape (single bulk POST):
  - `projects_ids: integer[]` (REQUIRED).
  - `emails: string[]` (optional).
  - `users_ids: integer[]` (optional).
- Mutex: "Exactly one of `emails` or `users_ids` must be non-empty" — but they CAN both be filled in one call (per the "and/or" wording on yaml :3423). So they are NOT mutex on the wire; they are jointly required-non-empty.
- Response: `{ newly_invited_users_to_projects, newly_created_users, newly_invited_users, removed_users_from_projects }` — multiple buckets.
- `acl_tasklists` mentioned in yaml :3434 description but NOT in the body schema. Following the R29 / R31 / R32 rule ("don't guess the API; defer flags not documented in body schema"), `--acl-tasklist` is deferred as a follow-up R33.5.
- `removed_users_from_projects` exists per yaml :3494-3497. Tracked in envelope but informational — no destructive intent.
- Tier: confirmed Yellow.

## Decision summary

Proceed to spec / plan / implement. Pause-on-policy not triggered.
