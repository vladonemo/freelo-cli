# Triage — R37 `tasks estimate`

**Run:** 2026-05-09-2141-r37-tasks-estimate
**Tier:** **Yellow**
**Type:** `feat`

## Rationale

- New user-visible commands (`tasks estimate set`, `tasks estimate clear`) — Yellow trigger ("New user-visible command or flag (additive)").
- Two new envelope schemas (`freelo.tasks.estimate.set/v1`, `freelo.tasks.estimate.clear/v1`) — additive, Yellow.
- Changeset will be `minor` — Yellow.
- No touch to `src/config/`, auth flows, `src/api/client.ts`, TLS/retry/redirect defaults — not Red.
- No new runtime dependencies — does not escalate to Red.
- No breaking changes — does not escalate to Red.
- One new destructive verb (`clear`) — reuses the existing `confirmDestructive` gate from R13/R35/R36; no new security surface.

## Route flags

- `needsSecurityReview: false` — no auth/config/client changes, no new secret storage, no new I/O channels.
- `requiresFreeloApi: false` (lookup mode only) — already confirmed during run-prep that `docs/api/freelo-api.yaml:2254-2377` documents all four endpoints unambiguously. The request body shape is `{ minutes: integer }` (required), response is the generic `SuccessResponse`. The per-user endpoint behaves identically to the total endpoint (only the path differs).
- `preApprovedDeps: []` — no new deps.

## Open question check

None. The OpenAPI is unambiguous on:
- Request body: `{ minutes: integer }`, `required: [minutes]`.
- Response: `SuccessResponse` (`{ result: 'success' }`) on both POST and DELETE.
- Idempotency on DELETE: yaml :2299 explicitly states 200 even when no estimate exists; same wording at :2362 for per-user.
- Per-user endpoint: same upsert + idempotent semantics as total; only path differs.
- ACL on per-user: 403 / 404 if `user_id` not assignable (yaml :2326); the CLI surfaces this as `FreeloApiError` from the wire — no special handling needed.

The `--user` flag toggle between the two endpoint paths is a straightforward branch in the command layer.

## Pre-approved scope

- Two new sibling-leaf commands under a new `tasks estimate` parent (R35 precedent — parent + leaves when leaves share an option surface like `--user`).
- Two new envelope schemas.
- One new API client file (`src/api/tasks-estimate.ts`).
- One new schema file (`src/api/schemas/task-estimate.ts`).
- Two new MSW handler blocks.
- Two new integration test files.
- One new docs file (`docs/commands/tasks-estimate.md`).
- One changeset entry.
- README autogen regeneration via `pnpm fix:readme`.

## Risk-tier flow

Yellow → full pipeline → open PR → **stop before merge** for human review.

`autoShip: false` in run params reinforces the no-merge stance.
