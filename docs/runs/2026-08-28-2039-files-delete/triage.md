# Triage — 2026-08-28-2039-files-delete

**Tier:** Yellow
**Commit type:** feat

> Note: the `Task` sub-agent tool is disabled in this session, so the orchestrator executed the
> `triage` agent's mandate (`.claude/agents/triage.md`) inline rather than delegating. Same output
> contract. See decision 1.

## Summary

Add `freelo files delete <uuid>...`, a new destructive leaf on the existing `files` command group,
wrapping `DELETE /file/{file_uuid}` (`deleteDocOrFileByUuid`, `docs/api/freelo-api.yaml` :4492-4521).
The endpoint soft-deletes either a file or a document/note, resolving the resource kind from the UUID
itself. Batch-capable (positional variadic / `--ids` / `--stdin` NDJSON) with `--dry-run` and the shared
`--yes` confirmation gate, structurally mirroring `src/commands/comments/delete.ts` (M01) and
`src/commands/tasks/delete.ts` (R13).

## Signals

- [x] Touches `src/commands/` (new subcommand leaf `files delete`)
- [ ] Touches `src/config/`
- [ ] Touches `src/api/client.ts` or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema — **new** schema `freelo.files.delete/v1` (additive; no existing
      envelope field removed, renamed or retyped)
- [ ] Changes exit codes (reuses the established 0/1/2 contract; no new codes)
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API (`DELETE /file/{file_uuid}`)
- [ ] Docs-only

## Route flags

- requiresFreeloApi: true
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

**Yellow**, confirming the roadmap's guess rather than deferring to it. The deciding signals are the
Yellow triggers "new user-visible command or flag (additive)" and "changeset is `minor`": this adds a
brand-new destructive verb plus a new `freelo.files.delete/v1` envelope schema, both purely additive.

Checked and rejected **Red**: nothing in scope touches `src/config/`, auth flows, `src/api/client.ts`,
or TLS/retry/redirect defaults; there is no breaking change (no flag removed, no exit code changed, no
existing envelope field altered); no dependency is removed or major-bumped. The one design question the
requirement flags (404 idempotency policy) is *not* Red-grade ambiguity — the requirement supplies an
explicit decision procedure ("read the endpoint description in the OpenAPI spec") and the spec text
answers it unambiguously (see Open concerns), so the architect can settle it autonomously and log it.

Checked and rejected **Green**: a new user-visible command can never be Green under the tier table, and
this one is destructive besides.

`needsSecurityReview: false` — the security-auditor trigger in `.claude/docs/sdlc.md` §Phase 5 is "any
change touching `src/config/` or auth flows". This slice touches neither. It handles no secrets beyond
the standard `resolveCredentials` → `createHttpClient` path used identically by every other command, and
the destructive-op gate is `src/lib/confirm.ts` reused verbatim (R13, already audited). Nothing new to
audit. The code-reviewer still checks the fail-closed non-TTY confirmation path.

## Open concerns

Things the architect must resolve in the spec:

1. **404 idempotency policy — the load-bearing decision of this slice.** The requirement correctly
   insists this be re-derived, not copied from M01. Evidence found during triage, from the endpoint's
   own description at `docs/api/freelo-api.yaml` :4504:

   > Returns 404 if no file or document matches the UUID, **or the caller has no access to it**.

   That is the same ACL-hides-existence shape M01 found on `DELETE /comment/{comment_id}` — a 404 here is
   genuinely ambiguous between "already gone" and "exists but isn't yours". It therefore does **not**
   satisfy the precondition for the `src/lib/idempotency.ts` / `already_in_target_state: true` pattern,
   which requires 404 to unambiguously mean "already in the target state". The architect should confirm
   this reading against the full endpoint block and record it as a decision with the yaml line cited.

2. **UUID input parsing, not integer parsing.** Unlike M01/R13, ids here are UUID strings. R27
   (`src/commands/files/download.ts` :52,65-72) already has a strict 8-4-4-4-12 `UUID_REGEX` +
   `validateUuid` throwing `ValidationError`. Decide whether to lift that into a shared helper or
   duplicate it, and specify the `--stdin` NDJSON line schema accordingly (`{"uuid": "<string>"}`, not
   `{"id": <int>}`).

3. **Resource-kind naming in the envelope.** The endpoint deletes a file *or* a document/note and the
   response body carries no discriminator, so the CLI cannot report which kind it removed. The spec must
   say plainly that the envelope reports only the UUID, and the human copy must not claim "file" when it
   may have been a note.

4. **No 400 rewrite path.** M01 rewrote a 400 (expired 15-minute window). This endpoint documents no
   400 at all — only 200 and 404. Don't invent a rewrite for an undocumented status.

## Recommended branch name

`feat/files-delete`
