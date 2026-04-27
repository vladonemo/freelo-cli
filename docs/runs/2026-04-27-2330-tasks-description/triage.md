# Triage — R15 `freelo tasks description` (get/set)

**Run:** 2026-04-27-2330-tasks-description
**Date:** 2026-04-27

## Tier: **Yellow**

## Rationale

- **New user-visible commands** (`freelo tasks description get` and `freelo tasks description set`) — Yellow trigger.
- **Two new envelope schemas** added (additive): `freelo.tasks.description.get/v1`, `freelo.tasks.description.set/v1` — Yellow.
- Touches **no** auth, config, HTTP-client defaults, or release tooling — not Red.
- **No new runtime dependencies** — `node:fs/promises`, `node:child_process`, `node:os`, `node:url` are stdlib; `readStdinToString` already exists in `src/lib/stdin.ts`. — not Red.
- No breaking change to envelope schema, exit codes, or flag names — not Red.
- Endpoints (`GET /task/{id}/description`, `POST /task/{id}/description`) **fully documented** in `docs/api/freelo-api.yaml:2002-2065` — no API ambiguity, no need to pause.
- `getTaskDescription` wire wrapper **already exists** in `src/api/tasks.ts:187-199` (R08 spec 0018).
- Spec is well-scoped; UX questions about `$EDITOR` resolved autonomously (see decisions).
- Changeset will be `minor` (additive — Yellow trigger).
- This is the **first** introduction of `src/lib/input.ts` (editor / stdin / `--from-file` shared helper) per `docs/roadmap.md:686`. Helper is **generic** (no-secret, no-network, pure-ish) — not a config / auth / HTTP touch.

## Route flags

- `needsSecurityReview`: **false** — no secrets, no auth flow, no config-storage changes. Editor-spawn is bounded (uses caller's `EDITOR` env, no shell interpolation) — flagged for code-reviewer attention but no full security audit.
- `requiresFreeloApi`: **false** — endpoints fully covered in `docs/api/freelo-api.yaml:2002-2065`; `freelo-api-specialist` consult **not needed** (no ambiguity).
- `preApprovedDeps`: **none needed** — only Node stdlib + existing repo modules.

## Risk-tier gate

Yellow. Open PR, leave for human review. **Do NOT enable auto-merge.**

## Calibration callouts

- §1 / §2 / §3 / §4 all apply (explicit exit-code tests, gates run on committed tree, every new try/catch arm tested, branch from `main`).
- The new `src/lib/input.ts` helper introduces `try/catch` arms (file read, editor spawn, stdin read) — **each new arm requires a test** (Calibration §4).
- Every typed error class triggered by these commands needs an exit-code assertion test (Calibration §2): `ValidationError` (exit 2), `FreeloApiError` 401/403/404/422/5xx (exits 3/4/4/4/4), `NetworkError` (exit 5), `RateLimitedError` (exit 6).
