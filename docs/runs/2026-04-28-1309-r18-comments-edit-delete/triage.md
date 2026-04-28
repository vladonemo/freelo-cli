# Triage — R18 `comments edit` / `comments delete`

**Run:** 2026-04-28-1309-r18-comments-edit-delete
**Phase:** triage
**Decided by:** orchestrator (assisted by inline OpenAPI inspection)
**Date:** 2026-04-28

## Tier: Red — pause at intake

## Rationale

Triage normally would land Yellow (two new user-visible write commands, additive surface, `minor` changeset, no new deps, first destructive op for the `comments` resource group but reusing `src/lib/confirm.ts` from R13). However, the requirement contradicts the canonical API contract on **both** endpoints — and `.claude/docs/autonomous-sdlc.md` §Failure modes binds: "Spec says something the OpenAPI spec contradicts → Pause — Freelo's contract is authoritative." Hard Rules: "Never guess API behavior. If `docs/api/freelo-api.yaml` doesn't answer the question, pause and ask `freelo-api-specialist` to capture a fixture."

This is a Red trigger per `autonomous-sdlc.md` §Risk tiers: "API behavior not in `docs/api/freelo-api.yaml`" + "Requirement itself is ambiguous about scope or UX."

## Contract contradictions found

| Requirement says | `docs/api/freelo-api.yaml` (canonical) says |
|---|---|
| `PATCH /comment/{comment_id}` for edit | `POST /comment/{comment_id}` for edit (yaml :2619-2663, `operationId: editComment`); explicit note: "The method used is `POST` for historical reasons, not `PUT`/`PATCH`." |
| `DELETE /comment/{comment_id}` for delete | **Does not exist.** The only operation declared on `/comment/{comment_id}` is `post`. No `delete:` key anywhere on a comment path. The Comments tag has exactly three endpoints: `POST /task/{task_id}/comments` (R17, add), `POST /comment/{comment_id}` (edit), `GET /all-comments` (R16, list). |

Verification:
- Searched yaml for `/comment/` paths → 1 hit (line 2619).
- Searched yaml for `delete:` operations → 16 hits, none on a comment path.
- Searched yaml for the literal `comment` (case-insensitive) across all yaml lines → no `deleteComment`/`removeComment`/`destroyComment` operationId, no comment-delete endpoint.

## Routing flags

- `requiresFreeloApi`: **true** (must consult freelo-api-specialist before unpausing — but the spec is unambiguous on this question; the gap is a missing endpoint, not an underspecified one)
- `needsSecurityReview`: false (no auth / config / TLS surface)
- `preApprovedDeps`: []
- `expected changeset`: `minor` (per requirement) — **may need re-scope** depending on resolution

## Why pause now and not after spec phase

The requirement assumes the existence of one endpoint that doesn't exist in the canonical contract, and gets the HTTP verb wrong on the second. Pushing to architect/spec without resolving these would either:

1. Force the spec to invent endpoint behavior (forbidden by Hard Rules),
2. Or quietly drop `comments delete` from scope (a unilateral scope reduction the orchestrator should not make per the §Autonomous decisions table — "Business question … → Pause").

Both edges are worse than asking. Pausing here costs zero retries and zero implementation budget.

## Budget consumed pre-pause

- Wall clock: ~3 min
- Agent invocations: 0 (orchestrator only — no specialist agent fired)
- Phase retries: 0
- Files touched: 0

The pause leaves the full 30 min / 40 calls / 8 retries / 25 files budget intact for the resumed run.
