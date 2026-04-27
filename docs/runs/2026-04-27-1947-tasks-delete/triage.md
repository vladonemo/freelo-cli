# Triage — R13 `freelo tasks delete <id>`

**Run:** 2026-04-27-1947-tasks-delete
**Date:** 2026-04-27
**Tier:** **Yellow**

## Rationale

R13 adds the `freelo tasks delete <id>...` subcommand and ships the **first destructive-op confirmation helper** (`src/lib/confirm.ts`) used by every later destructive command. Tier signals:

| Signal | Status |
|---|---|
| New user-visible command | yes — `tasks delete` |
| New envelope schema | yes — `freelo.tasks.delete/v1` (additive) |
| Touches `src/config/` / auth / HTTP client / TLS | **no** |
| New runtime dependency | **no** — `@inquirer/prompts` already in deps |
| Breaking change | **no** |
| Cross-cutting helper introduced | **yes** — `src/lib/confirm.ts` |
| Security finding | not yet — auditor not invoked unless review escalates |

Yellow triggers (any one): "new user-visible command or flag (additive)" and "new field added to an envelope schema". Both apply. Cross-cutting helper warrants careful review but does not push to Red — no auth, no breaking change.

## Route flags

- `requiresFreeloApi`: yes (DELETE /task/{task_id} — already documented in `docs/api/freelo-api.yaml` :1697-1714)
- `needsSecurityReview`: **yes** — destructive-op confirmation flow + first time the CLI deletes user data. Not config/auth, but the policy "non-TTY without --yes fails closed" is a user-trust boundary. Run security-auditor after code-reviewer.
- `preApprovedDeps`: [] — no new deps
- `changeset`: `freelo-cli: minor`

## Notes for orchestrator

- `confirm.ts` is small but cross-cutting. Calibration §4 applies: every new branch (TTY+yes, TTY-no-yes-prompt, non-TTY-no-yes-throw) needs explicit test coverage.
- Idempotency: 404 after a prior DELETE → success with `already_in_target_state: true`. Treat 404-on-DELETE as the "already deleted" signal (defensive — no GET pre-check is reliable here; see spec).
- Keep `@inquirer/prompts` import lazy (TTY branch only). Static imports would tank agent cold-path performance.

## Flow

Yellow flow: full pipeline → open PR → leave for human review and merge. Do **not** auto-merge.
