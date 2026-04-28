# Triage — R20

**Run:** `2026-04-28-2100-r20-time-stop-edit`
**Date:** 2026-04-28
**Tier:** **Yellow**
**Triager:** orchestrator

## Tier rationale

Two new user-visible commands (`time stop`, `time edit`) under the existing `time` parent:

- **Additive surface only** — no existing command, flag, or envelope changes.
- **Two new envelope schemas** — `freelo.time.stop/v1`, `freelo.time.edit/v1`. Both `/v1`, no schema bumps.
- **No auth / config / HTTP-client / TLS / retry / redirect changes.**
- **No new runtime dependencies.** All needed primitives (`zod`, `commander`, `undici`) already present.
- **No removed flags, exit codes, or schema fields.**
- **No security-sensitive flows touched.** Tokens still resolved via existing `resolveCredentials`; nothing new is logged or persisted.

Per `.claude/docs/autonomous-sdlc.md` Yellow triggers: "New user-visible command or flag (additive)" and "Changeset is `minor`" both apply. None of the Red triggers apply.

## Route flags

```yaml
needsSecurityReview: false       # no auth / secrets / config touched
requiresFreeloApi: true          # POST /timetracking/stop, POST /timetracking/edit
preApprovedDeps: []              # no new deps expected; pause if discovered
```

## OpenAPI discrepancy callouts (load-bearing for the spec)

Two roadmap statements that the OpenAPI authoritative document contradicts:

1. **HTTP verb on edit.** Roadmap says `PATCH /timetracking/edit`; OpenAPI (yaml :2812) says `post:`. Orchestrator instruction: follow OpenAPI. Spec records this discrepancy; commit message and changeset call it out.
2. **`--started-at <ISO>` flag on edit.** Roadmap proposes this flag, but the OpenAPI request body (yaml :2830-2843) lists only `task_id` and `note` — no `date_reported` / `started_at`. Sending an undocumented field would be guessing API behavior, which is a hard rule violation. **Decision (decision 1, see decisions dir): defer `--started-at` to a follow-up slice (R20.5), mirroring the R19 → R19.5 pattern for `--at` on `time start`.** R20 ships the documented surface only.

In addition, R20 will **add** a flag the roadmap doesn't list: `--task <id>` / `--no-task` on `time edit`, since OpenAPI documents `task_id` as a settable (nullable) field on the edit body. Agents need to be able to reassign / disassociate the task. Documented as decision 2.

## Pre-flight check

- Working tree clean on `main` at `3bc38f9` (R19.5 merged via PR #63). Verified.
- `pnpm install --frozen-lockfile` ran clean (parent already executed).
- R19 (`time start`/`time status`) and R19.5 (`--at`) shipped — code precedent fully in place.

## Stuck-loop prevention checklist

- Time-edit hint rewriter mirrors time-start's 409 pattern; will inherit any Calibration §4 try/catch coverage discipline from there.
- Both commands are simple flag-set wrappers — no batch surface (singleton-per-user precludes it, same as R19).

## Decision

**Proceed with Yellow flow:** spec → plan → implement → test → review → docs → commit/push/PR → leave for human review.
