# Run requirement — R19.5

**Run id:** 2026-04-28-2050-r19.5-time-start-backdate
**Started:** 2026-04-28
**Branch:** feat/time-start-backdate (to be created from main @ f508dfc)
**allowNetwork:** false (MSW only)
**autoShip:** false
**Budgets:** 30 min wall, 40 agent calls, 8 retries, 25 files

## Requirement (verbatim from `docs/roadmap.md`)

R19.5 — `freelo time start --at <ISO>` (backdate, queued)

Outcome: Backdate a newly started session's start timestamp — useful when a user forgot to start the timer at the real start time, or when an integration replays a "moved to in-progress" event after the fact.

Endpoints: same as R19 — `POST /timetracking/start`. The OpenAPI documents the optional `date_reported` body field: *"defaults to 'now' (server time) if not provided. Passing an explicit `date_reported` backdates the session's start time."* (`docs/api/freelo-api.yaml:2744`).

Surface (additive on top of R19):

```
freelo time start --task <id> [--note <str>] [--at <ISO>] [--dry-run]
```

Ships with this slice:
- New `--at <ISO>` flag on `time start`. Validated client-side as an ISO 8601 timestamp (reuse the date-parsing helper used by `--due` in `tasks create`); on parse fail throw `ValidationError` (exit 2) with `hintNext` pointing at `--at YYYY-MM-DDTHH:MM:SSZ`.
- Forwarded to the request body as `date_reported`. When `--at` is omitted, the body field is omitted entirely (server defaults to "now") — do NOT send `date_reported: null` to keep wire diffs clean.
- `--dry-run` envelope's `data.would.body` reflects the `date_reported` value when present.
- Decide during `/spec`: clamp clock-skew futures (refuse `--at` more than N seconds in the future), and whether `--at` is allowed at all when the result would be older than some sanity threshold (e.g. > 30 days back). Mirror whatever Freelo's server-side validation does, don't invent stricter rules.

Why it wasn't in R19: the original R19 roadmap line specified only `--task` / `--note`, and the spec implemented exactly that surface. The `date_reported` body field is documented in the OpenAPI but was never surfaced as a CLI flag.

Tier: Yellow (additive flag on an existing user-visible command; no envelope schema change; no auth/HTTP defaults change).
Changeset: `freelo-cli: minor` (new flag).
Depends on: R19.

## Pre-resolved decisions (record + proceed)

1. **No `--at` ⇒ no `date_reported` in body.** Don't send `date_reported: null`.
2. **Single-id command (R19 inherited).** No batch input.
3. **Tier is Yellow.** Auto-merge OFF; finish at PR open.
4. **Changeset bump is `minor`.**

## Open questions for /spec to resolve (decide + log)

1. Clock-skew clamp on `--at` futures (recommend 60s).
2. Sanity threshold on far-past `--at` (recommend: none client-side; mirror server).
3. ISO 8601 acceptance shape (recommend: reuse `--due` parser; canonical UTC).

## Hard constraints

- No envelope schema bump (`freelo.time.start/v1` stays).
- No new dependencies.
- `--dry-run` must already work — surface `date_reported` only when `--at` was passed.
- `--introspect` golden updates with the new flag.
- `pnpm check:readme` must pass.

## Five-gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
