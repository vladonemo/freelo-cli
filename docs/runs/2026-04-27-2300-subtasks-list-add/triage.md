# Triage — R14 `freelo subtasks` (smart list)

**Run:** 2026-04-27-2300-subtasks-list-add
**Date:** 2026-04-27
**Decided by:** orchestrator (per `.claude/docs/autonomous-sdlc.md` risk-tier rubric)

## Tier: Yellow

## Rationale

Yellow triggers (per autonomous-sdlc.md §Risk tiers — Yellow):

- **New user-visible commands or flags (additive):** `freelo subtasks list`, `freelo subtasks add` — both new commands under a brand-new top-level subcommand `subtasks`.
- **New fields added to envelope schemas (backwards-compatible):** Two new schemas — `freelo.subtasks.list/v1`, `freelo.subtasks.add/v1`. Additive only.
- **Changeset is `minor`:** new feature surface.

Red triggers absent:
- No touch to `src/config/`, auth flows, `src/api/client.ts`, TLS/retry/redirect defaults.
- No removed flags / changed exit codes / changed envelope schema (all schemas are net-new).
- No dependency removal or major bump; **no new dependencies** at all (`@inquirer/prompts` not needed — additive write does not require confirmation per CLAUDE.md "destructive-only" gate).
- No spec ambiguity (the OpenAPI contract pins both endpoints, R08 already has `SubtaskSchema`).

Green triggers absent:
- New user-visible command, so above the read-only-refactor bar.
- Two envelope schemas land — public contract surface area expands.

## Route flags

- `needsSecurityReview`: **false** (no auth/config surface; no secrets path; reuses existing HTTP client and credential resolution).
- `requiresFreeloApi`: **true** (both endpoints `GET/POST /task/{task_id}/subtasks` documented in `docs/api/freelo-api.yaml` :2380-2443; freelo-api-specialist will sanity-check the request/response shapes during /spec).
- `preApprovedDeps`: `[]` — none requested, none expected.
- `autoMerge`: **false** — Yellow stops at PR-open per requirement.
- `autoShip`: **false** — explicitly disabled by run parameters.

## Pause check

No pause. Requirement is well-scoped, OpenAPI contract is clear, and all new surface is additive.

## Plan flow

Proceed straight to spec → plan → implement → test → review → docs → PR-open. Stop.
