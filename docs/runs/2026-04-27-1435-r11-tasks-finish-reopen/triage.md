# Triage — R11 `tasks finish` / `tasks reopen`

**Run:** 2026-04-27-1435-r11-tasks-finish-reopen
**Tier:** Yellow

## Rationale

Triggers from `.claude/docs/autonomous-sdlc.md` §Risk tiers:

| Trigger | Hit? |
|---|---|
| New user-visible command or flag (additive) | YES — two new commands |
| New field added to an envelope schema (backwards-compatible) | YES — two NEW envelopes (`freelo.tasks.finish/v1`, `freelo.tasks.reopen/v1`) |
| New non-security dependency | NO |
| Changeset is `minor` | YES |
| Touches `src/api/client.ts`, `src/config/`, auth, TLS/retry defaults | NO |
| Breaking change | NO |
| Critical security finding | n/a |

→ Yellow.

## Route flags

- `needsSecurityReview`: false — no secret handling, no config writes, no new auth surface; the new helper `src/lib/idempotency.ts` is a pure success-shape detector.
- `requiresFreeloApi`: true — `POST /task/{id}/finish` (OpenAPI :1815) and `POST /task/{id}/activate` (OpenAPI :1789). Spec already cached locally; no `--allow-network` needed.
- `preApprovedDeps`: [] — no new deps required.

## Stuck-loop detection

Enabled (default). Two identical failures pause immediately.

## Notes for the spec phase

- API behavior on already-target-state (key for the idempotency helper):
  - `/task/{id}/activate` on an active task → 200, no changes (OpenAPI :1802).
  - `/task/{id}/finish` on a finished task — OpenAPI does not state explicitly, must verify via spec text. Pause if ambiguous; otherwise pre-check via `GET /task/{id}` (already wired through `getTaskDetail`).
- The roadmap calls out the helper "detects 'already in target state' responses (or pre-checks state)". Pre-check is the safer default since the API doesn't guarantee a 200 for finish-on-finished.
- R09's `pickWorkerWithNotice` pattern, R10's lookup-then-fanout pattern, R09's `--stdin` NDJSON streamer, and `dryRunEnvelope` from `src/lib/dry-run.ts` are all reusable.
