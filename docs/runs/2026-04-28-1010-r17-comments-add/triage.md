# Triage — R17 `freelo comments add`

**Run:** 2026-04-28-1010-r17-comments-add
**Tier:** Yellow

## Rationale

- New user-visible subcommand under existing `comments` group (Yellow trigger: "New user-visible command or flag (additive)").
- New envelope schema added: `freelo.comments.add/v1` (additive, version 1 — Yellow trigger "New field added to an envelope schema (backwards-compatible)" generalized to "new schema").
- No touch to `src/config/`, `src/api/client.ts`, auth flows, retry/redirect defaults — not Red.
- No new runtime dependency.
- No breaking change to existing schemas/exit codes/flags.
- Not destructive (a comment is created, never removed) — `--yes` confirmation gate not required.
- Reuses `src/lib/input.ts` (R15) and `dryRunEnvelope` (R09) — well-trod patterns.

## Routes

- `needsSecurityReview`: **false** — no auth/config/secret-handling surface.
- `requiresFreeloApi`: **false** — endpoint already documented in `docs/api/freelo-api.yaml:2576-2617`; no fixture capture needed.
- `preApprovedDeps`: **[]** (no new deps required).

## Risk highlights for review

- `POST /task/{task_id}/comments` has a non-obvious server-side behavior: **the first POST to a task with no prior comments creates the task description, not a comment** (yaml :2590). The CLI must call this out in help text and the docs page, since R15 already provides `tasks description set` as the explicit description path. The `data` envelope must surface enough to let an agent detect this case — the API response carries `is_description=true` for that flip.
- `--message` adds a fourth source variant on top of R15's three (`--from-file`, `--editor`, `-`). Mutex grows from 3-way to 4-way; pickInputSource logic must handle this without duplicating `src/lib/input.ts`.
- Idempotency is **N/A** here (each POST creates a new comment) — must be documented in the spec under "Idempotency" so future maintainers don't try to retrofit a check.

## Budget at start

- Wall: 30 min (started 10:10)
- Calls: 40
- Retries: 8
- Files: 25
