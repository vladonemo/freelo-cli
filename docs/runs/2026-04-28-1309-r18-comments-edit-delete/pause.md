## Paused at triage

**Run:** 2026-04-28-1309-r18-comments-edit-delete
**Reason:** R18 requirement contradicts the canonical OpenAPI contract on both endpoints; per Hard Rules + Failure modes table, the orchestrator must not guess API behavior.
**Risk tier:** Red

### What happened

Triage inspected `docs/api/freelo-api.yaml` for the two endpoints R18 names (`PATCH /comment/{comment_id}` and `DELETE /comment/{comment_id}`) and found the canonical contract disagrees on both:

1. The edit endpoint exists, but as `POST /comment/{comment_id}` (`operationId: editComment`), with an explicit yaml note: "The method used is `POST` for historical reasons, not `PUT`/`PATCH`."
2. The delete endpoint **does not exist at all**. There is no `delete:` operation on `/comment/{comment_id}` anywhere in the yaml; no comment-delete operationId; no comment-delete path. The Comments tag declares exactly three operations (R17 add, edit, R16 list).

The orchestrator paused before invoking architect/spec because pushing forward would force the spec to invent unverified endpoint behavior or to silently drop half the requirement — both forbidden by `autonomous-sdlc.md` (Hard Rules + §Autonomous decisions).

### Evidence

- `docs/api/freelo-api.yaml:2619-2663` — only operation on `/comment/{comment_id}` is `post:` (edit). No sibling `delete:`.
- `docs/api/freelo-api.yaml:2634` — yaml comment: "The method used is `POST` for historical reasons, not `PUT`/`PATCH`."
- `docs/api/freelo-api.yaml` — `delete:` keyword search returns 16 hits, none on a comment path.
- `docs/api/freelo-api.yaml:2575-2727` — full Comments section: only `POST /task/{task_id}/comments` (R17), `POST /comment/{comment_id}` (edit), `GET /all-comments` (R16). No fourth.
- `docs/runs/2026-04-28-1309-r18-comments-edit-delete/triage.md` — full triage record.

### Decision needed

Two questions, ideally answered together. Please pick (or write a custom answer):

**Q1 — `comments edit` HTTP method.** The requirement says PATCH; the OpenAPI says POST. Which do we wire?

  A. Trust the OpenAPI contract — wire `POST /comment/{comment_id}`, update the requirement note to drop the PATCH mention. (Recommended — matches the canonical spec, R17 already uses POST for add so the convention is consistent within the comments resource.)
  B. Trust the requirement — wire PATCH and update `docs/api/freelo-api.yaml` to match (requires a separate spec-update PR first; signals the OpenAPI is stale).
  C. Pause longer — ask `freelo-api-specialist` to probe both verbs against a real endpoint before deciding.

**Q2 — `comments delete` endpoint.** It is not in the OpenAPI. Options:

  A. Drop `comments delete` from R18 entirely; ship only `comments edit` in this slice. Open a separate roadmap item for the delete operation that begins with confirming the endpoint exists (possibly via `freelo-api-specialist` probing or upstream Freelo docs). R18 changeset stays `minor` but with one command, not two.
  B. Ship `comments delete` anyway against an endpoint URL we'll **assume** is `DELETE /comment/{comment_id}` — the symmetric REST guess. **Strongly NOT recommended** — violates Hard Rules and risks shipping a command that 404s or silently no-ops in production.
  C. Pause longer — invoke `freelo-api-specialist` with `--allow-network` (or against a manual fixture you provide) to discover the real delete endpoint (DELETE? POST `/comment/{comment_id}/delete`? Soft-delete via edit with `is_deleted=true`?), update the OpenAPI yaml in a precursor PR, then resume R18 against the corrected spec.
  D. Drop `comments delete` permanently; document in the spec that Freelo v1 has no comment-delete endpoint and link to a Freelo support ticket.

### Resume with

```
/resume 2026-04-28-1309-r18-comments-edit-delete <answers>
```

Examples:
- `/resume 2026-04-28-1309-r18-comments-edit-delete Q1=A, Q2=A`
- `/resume 2026-04-28-1309-r18-comments-edit-delete Q1=A, Q2=C — please run the api-specialist with allow-network against the test account`
- `/resume 2026-04-28-1309-r18-comments-edit-delete Abort`

### State on disk

- Branch: still on `main` (no `feat/comments-edit-delete` branch was created — pause happened before phase 5/§"5. Create branch").
- Working tree: clean except for `docs/runs/2026-04-28-1309-r18-comments-edit-delete/` (run artifacts: `requirement.md`, `triage.md`, this `pause.md`).
- No commits, no pushes, no PR.
- Budget consumed: ~3 min wall, 0 agent invocations, 0 retries, 0 files-of-record touched.
