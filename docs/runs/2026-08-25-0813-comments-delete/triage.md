# Triage — 2026-08-25-0813-comments-delete

**Tier:** Yellow
**Commit type:** feat

## Summary

Add `freelo comments delete <id>...`, the delete verb on the `comments` resource, wrapping
`DELETE /comment/{comment_id}` (`operationId: deleteComment`, `docs/api/freelo-api.yaml` :3203-3232).
It is a destructive command in the R13 mould — `--yes` / TTY-confirm gate, `--dry-run`, and the three
batch input sources (positional variadic, `--ids`, `--stdin` NDJSON) — on the same resource as the
existing R18 `comments edit`. Two endpoint-specific error surfaces are load-bearing: ACL failures come
back as 404 (not 403) by design, and a 400 means the 15-minute post-time deletion window has expired.

## Signals

- [x] Touches src/commands/ (new/changed subcommand)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (`freelo.*/vN`) — **new** schema `freelo.comments.delete/v1`; no existing schema touched
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags

- requiresFreeloApi: true (design-time only — endpoint is fully documented in the cached OpenAPI spec; **no live calls**, `allowNetwork: false`)
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

Yellow, confirming the roadmap slice's own recommendation. It is a **new user-visible command** (additive)
carrying a **new envelope schema** and a `minor` changeset — three separate Yellow triggers. No Red trigger
fires: nothing under `src/config/`, no auth flow, no `src/api/client.ts` or HTTP-default change, no removed or
renamed flag, no exit-code change, no dependency movement. `--yes` / `-y` already exists as a global flag
(`src/bin/freelo.ts`) so even the confirmation gate is a reuse, not a new surface.

The requirement is **not ambiguous** — it names the exact endpoint, the exact CLI shape, the two sibling
commands to mirror, and pre-answers the one genuinely contestable design question (how to surface the 404).
No pause-at-triage.

## Open concerns

Three things the architect must settle in the spec, all with enough information already on hand to decide
without pausing:

1. **404 is NOT idempotent-success here.** `src/commands/tasks/delete.ts` (R13) re-classifies a 404 on DELETE
   as `already_in_target_state: true`. That is wrong for comments: per yaml :3216, a 404 also means "you are
   not the author", so absorbing it would report success to a user who deleted nothing. The requirement
   explicitly directs "surface this as a plain not-found error". The spec must state the divergence from R13
   loudly, and it needs a decision-log entry because it breaks a codebase-wide convention.
2. **400 must not be a generic passthrough.** `FreeloApiError.fromResponse` maps any non-401/403/404/5xx to
   `FREELO_API_ERROR` with the message `Freelo API error (HTTP 400).` — useless here. Rewrite message +
   `hintNext` at the command layer, following the existing `rewriteEditCommentHint` precedent in
   `src/commands/comments/edit.ts` :618-633. Decide explicitly whether a new `FreeloApiErrorCode` value is
   warranted (touching shared error infra) or whether the message/hint rewrite suffices.
3. **The delete response has no body schema** (yaml :3227-3228 documents a bare `200 Comment deleted`), unlike
   `editComment` which returns a `Comment`. The envelope's `data` therefore has nothing server-derived to
   carry — mirror `TasksDeleteData`'s echo-the-input shape rather than inventing fields.

Also in scope for the doc phase: `docs/roadmap.md` §R18.5 flips from "Blocked on Freelo API confirmation" to
shipped, and `docs/roadmap-migration-2026-08.md` §M01 gets its status updated.

## Recommended branch name

`feat/comments-delete`

---

```
TRIAGE run=2026-08-25-0813-comments-delete tier=Yellow type=feat flags=[requiresFreeloApi]
```
