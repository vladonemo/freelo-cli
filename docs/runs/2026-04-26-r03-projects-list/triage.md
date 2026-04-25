# Triage — R03 `freelo projects list`

**Run:** `2026-04-26-r03-projects-list`
**Tier:** **Yellow** (confirmed; spec already says Yellow at §0).
**Decided by:** orchestrator (re-triage on resumption).

## Tier rationale

Yellow triggers (autonomous-sdlc.md §"Yellow"):

- New user-visible command (`freelo projects list`) — additive.
- New flags (`--scope`, `--page`, `--all`, `--cursor`, `--fields`) — additive.
- New envelope schema `freelo.projects.list/v1` — additive (no existing schema retyped).
- Changeset will be `minor` (new command).

Not Green because:

- New pagination abstraction (`src/api/pagination.ts`) — first command with paging.
- New table renderer (`src/ui/table.ts`, lazy `cli-table3`) — first command with truly tabular output.
- First endpoint contact beyond `users/me`.

Not Red because:

- Does not touch `src/config/`, auth, `src/api/client.ts` defaults (TLS / retry / redirect).
- No security-auditor finding triggers.
- No breaking change to existing flags, exit codes, or envelope schemas.
- No new runtime deps in `package.json` — `cli-table3` and `ora` already listed in tech stack and `package.json` (`cli-table3` is in deps; verified below).

## Pre-approved deps

None new. `cli-table3` is already declared in `package.json` deps (verified — see "Pre-flight" section of `runlog.md`). `ora` is also already a runtime dep. Both land as actual lazy imports for the first time in this slice.

Wait — re-checking `package.json`: `cli-table3` is listed in the **CLAUDE.md tech stack** but it is **not** in `package.json` deps as of 0.4.0. The package.json shows `chalk, commander, conf, cosmiconfig, keytar, ora, pino, pino-pretty, undici, zod, @inquirer/prompts`. **`cli-table3` is missing from package.json.**

This is a deviation from the spec's note that "cli-table3 is already in package.json's declared tech stack but lands as an actual import (lazy) for the first time" — the tech stack doc declares it, but package.json does not. So we **do** add `cli-table3` as a new runtime dep in this slice.

Yellow tier still holds — adding a non-security pre-approved dep (declared in `.claude/docs/tech-stack.md`) for a Yellow change is allowed under the "new non-security dependency" Yellow trigger. Logged as decision 0001 below.

## Route flags

- `requiresFreeloApi`: **false** — spec is already complete and grounded; `docs/api/freelo-api.yaml` covers all five endpoints; freelo-api-specialist not re-invoked.
- `needsSecurityReview`: **false** — no auth, no secret storage, no HTTP defaults touch.
- `preApprovedDeps`: **`cli-table3`** (already declared in `.claude/docs/tech-stack.md` and explicitly cited in spec §6 as the renderer choice).

## Branch

`feat/projects-list` off `main` (`6c4a2e8`).

## Phases to run

2 (Plan) → 3 (Implement) → 4 (Test) → 5 (Review) → 6 (Document) → 7 (PR open + auto-merge per repo policy).

Skip security-review (no triggers).

## Decision log entries opened

- 0001 — `cli-table3` is a new package.json runtime dep (despite spec wording suggesting otherwise) — pre-approved via tech-stack declaration.
