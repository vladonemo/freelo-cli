# Requirement — R22 reports write

**Run:** 2026-04-29-1200-r22-reports-write
**Roadmap:** `docs/roadmap.md` R22 (line 440)
**Source:** Autonomous SDLC invocation, 2026-04-29 12:00.

## R22 line (verbatim)

> **Outcome:** Log work directly (without a live timer) and amend / remove entries.
> **Endpoints:** `POST /task/{task_id}/work-reports`, `PATCH /work-reports/{id}`, `DELETE /work-reports/{id}`.
> **CLI:**
>
> ```
> freelo reports log --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>]
> freelo reports edit <id> [--minutes <n>] [--note <str>] [--date YYYY-MM-DD]
> freelo reports delete <id> [--yes]
> ```
>
> **Ships with this slice:** currency/money helper if the backend asks for rate-in-cents on this endpoint (verify on first real call — see SKILL.md §Currency encoding).
> **Depends on:** R21.

## Pre-context (from invocation)

- Working tree clean. Local `main` was just fast-forwarded to `origin/main` (commit `7450ab4`). Do not reset, force-push, or amend any other branch's history.
- This is the first slice that adds three commands at once **and** a destructive command (`reports delete`). The destructive op MUST reuse `src/lib/confirm.ts` (R13) and `src/lib/idempotency.ts` (R11) per the roadmap's cross-cutting table. Do not invent a new confirmation flow.
- The "money helper" callout in the roadmap is **conditional** — only ship `src/lib/money.ts` if the spec phase confirms the API requires cents-as-string for log/edit. If unclear from the OpenAPI, pause rather than guess.
- Reports envelope schema family already exists from R21. Use:
  - `freelo.reports.log/v1` for POST `/task/{task_id}/work-reports`
  - `freelo.reports.edit/v1` for the edit endpoint (verb: see Phase 2 binding below)
  - `freelo.reports.delete/v1` for DELETE `/work-reports/{id}`
- Writes follow the agent-safe contract: `--dry-run`, batch input where it makes sense, idempotent on absorbing state.
- Destructive ops require `--yes` or TTY prompt; non-TTY without `--yes` → `ConfirmationError` exit 2.

## Budget

- 30 min wall clock
- 40 agent invocations
- 8 phase retries
- 25 files touched
- `allowNetwork=false` (MSW only)
- `autoShip=false` — open PR + auto-merge gating only
