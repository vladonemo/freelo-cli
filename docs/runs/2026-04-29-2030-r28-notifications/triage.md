# Triage — R28 `freelo notifications`

**Run:** 2026-04-29-2030-r28-notifications
**Tier:** **Yellow**
**Decided by:** orchestrator (no triage agent invocation — clear signals against the rubric)

## Signals

| Signal | Value |
|---|---|
| Touches `src/config/`, `src/api/client.ts`, auth, TLS/retry/redirect defaults | **No** |
| New runtime dependency | **No** |
| New user-visible command / flag | **Yes** (3 new subcommands, 1 new top-level group, ~7 new flags) |
| New envelope schema | **Yes** (3 additive: `freelo.notifications.list/v1`, `freelo.notifications.read/v1`, `freelo.notifications.unread/v1`) |
| Breaks existing flag / exit code / schema | **No** |
| Changeset bump | **minor** |
| Spec ambiguity / Open questions | **No** — OpenAPI is unambiguous on all three endpoints (`docs/api/freelo-api.yaml` :3618-3753; `Notification` schema :5841-5901). |
| Touches secrets, keychain, auth flows | **No** |
| Pre-approved deps | n/a |
| Security review trigger | **No** — user-scoped read/write notifications, no auth/config/secrets touch |

## Tier rationale

The change is the prototypical Yellow case: additive user-visible surface, additive schemas, no breaking change, no security touch. Per the autonomous-sdlc.md rubric, it runs the full pipeline through PR and stops before merge for human review.

## Route flags

```yaml
needsSecurityReview: false
requiresFreeloApi: true       # already verified all 3 endpoints present in docs/api/freelo-api.yaml
preApprovedDeps: []           # no new deps expected
allowNetwork: false           # MSW only for tests
autoShip: false               # tier gate stops at PR open regardless
```

## Pre-flight checks (manual)

- [x] `git status` clean, on `main` @ `d89b52f`.
- [x] All three endpoints documented in `docs/api/freelo-api.yaml`:
      - `GET /all-notifications` (yaml :3619-3694)
      - `POST /notification/{notification_id}/mark-as-read` (yaml :3696-3724)
      - `POST /notification/{notification_id}/mark-as-unread` (yaml :3726-3753)
- [x] Pagination shape: `PaginatedResponse` (yaml :4814) — same `{ total, count, page, per_page }` envelope used by every other paginated endpoint. `?p=N` zero-indexed (`PageParam` :4766).
- [x] `--unread` filter: server-side `only_unread=true` query param (yaml :3672-3676).
- [x] Idempotency: explicit in OpenAPI (`Idempotent — calling on an already-read notification returns 200.` yaml :3709, `Idempotent;` :3739) — but no GET-by-id endpoint, so the CLI cannot pre-check current state. The two write endpoints **always POST** (server is the idempotency authority; the response is a generic SuccessResponse with no `was_read` signal). This shapes spec §3.4 — see decision in spec.

No pause triggers. Proceed to Phase 2 (spec).
