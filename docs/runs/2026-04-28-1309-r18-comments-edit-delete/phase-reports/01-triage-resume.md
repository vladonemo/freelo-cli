# Resume — 2026-04-28 13:30 UTC

**Paused at:** phase 1 — triage (before spec)
**Run id:** 2026-04-28-1309-r18-comments-edit-delete

## Questions from `pause.md`

**Q1 — `comments edit` HTTP method.** Requirement said PATCH; OpenAPI says POST.
**Q2 — `comments delete` endpoint.** Not present in OpenAPI.

## Answer (verbatim)

`Q1=A, Q2=A`

## Interpretation

**Q1 = A** → **Trust the OpenAPI.** Wire `POST /comment/{comment_id}`. The requirement's "PATCH" wording in `docs/roadmap.md` §R18 will be corrected as part of this slice's PR (single-line touch-up to keep the roadmap honest going forward; not a separate PR).

**Q2 = A** → **Drop `comments delete` from R18.** Scope shrinks to a single command (`freelo comments edit`). The delete operation is deferred until a Freelo endpoint is confirmed to exist — file a follow-up roadmap item (R18.5 or similar) that begins with `freelo-api-specialist` probing the real API. **Do not** ship a `comments delete` command speculatively.

## Scope after resume

Single new command: `freelo comments edit <id>`.

- Endpoint: `POST /comment/{comment_id}` (canonical, despite REST norms — preserved from upstream).
- Inputs: same input pattern as `comments add` from R17 — `--message <str>` / `--from-file <path>` / `--editor` / `-` (stdin) — exactly one required (mutex).
- Agent-safe write contract inherited: `--dry-run`, batch via repeatable `<id>` / `--ids` / `--stdin` NDJSON.
- Idempotency: edit-with-same-content is **not** an absorbing-state write — every successful POST returns the updated comment. No `already_in_target_state: true` path needed for edit. (That helper would have served `comments delete`, which we are not shipping.)
- **No `--yes` / no confirm helper** in this slice — edit is non-destructive. `src/lib/confirm.ts` stays untouched.
- Output schema: `freelo.comments.edit/v1`. (`freelo.comments.delete/v1` deferred with the command.)
- Changeset: `freelo-cli: minor` (one new user-visible command).

## Tier after resume

**Yellow.** Additive surface, one new write command, no auth/HTTP-defaults change, no new dependency. Triage may re-confirm.

## Roadmap update riding with this PR

Edit `docs/roadmap.md` §R18 to:
- Replace the endpoint line with: `**Endpoints:** \`POST /comment/{comment_id}\` (note: "POST for historical reasons, not PUT/PATCH" per OpenAPI line 2634).`
- Drop the `comments delete` clause from the CLI block.
- Add a new entry — `R18.5 — \`freelo comments delete\` (queued)` — that records the gap: endpoint not in `docs/api/freelo-api.yaml` as of 2026-04-28; first action is to verify with `freelo-api-specialist` against a live test account.

## Next phase to enter

Phase 2 — spec (architect + freelo-api-specialist).
