# Triage (post-resume) — R18 `freelo comments edit`

**Run:** 2026-04-28-1309-r18-comments-edit-delete
**Phase:** 1 — triage (after `/resume Q1=A, Q2=A`)
**Decided by:** orchestrator
**Date:** 2026-04-28

## Tier: Yellow

## Rationale

Scope after resume is a single new write command — `freelo comments edit <id>` — wired to the canonical `POST /comment/{comment_id}` (yaml :2619-2663). The original ambiguity (PATCH vs POST, missing delete endpoint) is resolved: trust the OpenAPI; defer `comments delete` to R18.5.

The change is **additive**:

- New leaf command on the existing `comments` subcommand tree (registered in `src/commands/comments.ts`).
- New wire wrapper `editComment` in `src/api/comments.ts`; new `CommentsEditDataSchema` in `src/api/schemas/comment.ts`.
- New envelope schema `freelo.comments.edit/v1`.
- Reuses every existing helper: `src/lib/input.ts` (R15), `src/lib/batch.ts` (R09), `src/lib/dry-run.ts` (R09), `src/ui/envelope.ts` (R01). **No** confirm helper (non-destructive). **No** idempotency helper (every successful POST replaces content; not absorbing-state).
- One existing roadmap touch-up (`docs/roadmap.md` §R18 + new R18.5 entry).
- No auth, HTTP-defaults, config, TLS, or release-tooling change.
- No new runtime dependency.
- Changeset: `freelo-cli: minor`.

This matches the Yellow trigger set in `.claude/docs/autonomous-sdlc.md`:

- "New user-visible command or flag (additive)" → yes
- "New field added to an envelope schema (backwards-compatible)" → N/A (entirely new schema)
- "Changeset is `minor`" → yes

No Red triggers active:

- `src/config/`, auth, `src/api/client.ts` not touched
- No breaking change to envelope schema, exit codes, or flag names
- No dependency add/bump
- Spec will not have unresolvable Open questions (resume answer fixed both)

## Routing flags

- `requiresFreeloApi`: **true** — the OpenAPI is the contract. Spec must cite yaml :2619-2663 verbatim. Body shape is plain `{ content: string, files?: FileUpload[] }`; v1 ships only `content` (no multipart — R25 helper).
- `needsSecurityReview`: **false** — no auth / config / TLS / new I/O surface beyond what R15/R17 already shipped.
- `preApprovedDeps`: `[]` — nothing new.

## Scope after resume (verbatim)

- Single new command: `freelo comments edit <id>`
- Endpoint: `POST /comment/{comment_id}` (operationId `editComment`, yaml :2619-2663)
- Request body: `{ content: string }` (omit `files[]` — R25)
- Inputs (mutex, exactly one): `--message <str>` / `--from-file <path>` / `--editor` / `-`
- Batch over comment ids: positional `<id>...`, `--ids "a,b,c"`, `--stdin` (NDJSON `{id, content}` per row — varied content per row)
- `--dry-run` supported
- No `--yes` / no confirm helper (edit is non-destructive)
- No idempotency helper (no absorbing state)
- Output schema: `freelo.comments.edit/v1`
- Roadmap update rides with PR (drop PATCH/delete; add R18.5 queued)
- Changeset: `freelo-cli: minor`

## Budget consumed (since /resume)

- Wall clock: ~3 min cumulative (this re-triage was quick)
- Agent invocations: 0 (orchestrator only — no specialist fired yet)
- Phase retries: 0
- Files touched: 0

Remaining budget: ~24 min wall, ~40 calls, 8 retries, 25 files.

## Decision

Proceed to phase 2 (spec). The resume payload's interpretation is internally consistent with `autonomous-sdlc.md` and the OpenAPI; no further blocker on file.
