# Triage — R19 `freelo time start` / `time status`

**Run:** `2026-04-28-1628-r19-time-start-status`
**Tier:** **Yellow**

## Rationale

- New user-visible commands (`time start`, `time status`) under a new top-level resource `time`. Yellow per `autonomous-sdlc.md` §Risk tiers.
- No auth, config, HTTP-client-defaults, or release-tooling changes.
- No new runtime dependencies (uses existing `zod`, `commander`, `undici`, `pino`).
- Envelope additions only — no field removed/renamed/retyped from any existing schema (`freelo.time.start/v1` and `freelo.time.status/v1` are new contracts).
- Changeset bump: `minor` (two new user-visible commands).

## Route flags

- `needsSecurityReview`: **false** — no auth/secrets touched, no shell-out, no file writes outside dev artifacts.
- `requiresFreeloApi`: **true** — endpoints documented in `docs/api/freelo-api.yaml` :2729-2945. spec phase will invoke `freelo-api-specialist` to confirm request/response shapes (already pre-read by orchestrator).
- `preApprovedDeps`: `[]` — no new deps expected.
- `requirementAmbiguous`: **false** — roadmap entry + `freelo-api.yaml` cover all behavioral edges (singleton 409, 204 no-active).

## Pre-existing infra leveraged

- `src/api/client.ts` (HTTP client, request/abort/rate-limit, FreeloApiError mapping) — no change.
- `src/ui/envelope.ts` (envelope builder + schemas) — no change.
- `src/lib/dry-run.ts` (`--dry-run` mixin) — reused by `time start`.
- `src/errors/*` (`FreeloApiError`, `ValidationError`) — reused, including a singleton-409 hint rewriter local to `time start`.
- `src/lib/introspect.ts` `attachMeta` for command-tree discovery.

## Open shape decisions deferred to architect/spec

- Exact `data.active: false` shape for `time status` 204 path.
- Singleton-409 hint copy and `code` choice (`FREELO_API_ERROR` with rewritten `hintNext`, mirroring R17/R18 hint-rewriter pattern, vs. introducing `TIMER_ALREADY_RUNNING`).

No pause needed. Proceed to Spec.
