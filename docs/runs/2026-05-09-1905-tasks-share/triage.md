# Triage — R36 `freelo tasks share` / `unshare`

**Run:** `2026-05-09-1905-tasks-share`
**Phase:** 1 — triage
**Date:** 2026-05-09

## Risk tier: Yellow

Two new user-visible additive commands. New envelope schemas. Minor changeset.
No auth/config/HTTP-client touch. Mirrors R35 patterns byte-for-byte where
possible.

## Triggers (Yellow)

- New user-visible commands or flags (additive): `tasks share`, `tasks unshare`.
- New envelope schemas added (backwards-compatible additions to public schema
  registry): `freelo.tasks.share/v1`, `freelo.tasks.unshare/v1`.
- Changeset will be `minor` (new feature surface).
- No new runtime dependency.

## Triggers explicitly NOT hit

- Does NOT touch `src/config/`, auth flows, or `src/api/client.ts`.
- Does NOT change TLS / retry / redirect defaults.
- Does NOT remove or rename existing flags / fields / exit codes.
- No major version bump.
- No security-relevant code path (no new secret handling, no new auth).

## Route flags

- `needsSecurityReview: false` — no auth/config/secret-handling code path.
- `requiresFreeloApi: true` — needs API confirmation against
  `docs/api/freelo-api.yaml` because the roadmap shorthand says
  `POST /public-link/task/{id}` but the authoritative OpenAPI spec
  (`docs/api/freelo-api.yaml:2137-2185`) documents this as **GET** (a
  GET-that-creates pattern; second call returns the same URL). The DELETE
  shape does match the roadmap. The freelo-api-specialist must reconcile
  this in the spec phase.
- `preApprovedDeps: []` — no new dependencies expected; reuses
  `parseTaskId` pattern, the same `confirmDestructive` helper, the same
  `dryRunEnvelope` builder, and `buildEnvelope`.

## Pre-approved patterns (R35 / spec 0049 precedent)

- `src/api/schemas/<resource>.ts` — zod schemas + envelope `data` types.
- `src/api/<resource>.ts` — thin wire wrappers + path helper.
- `src/commands/tasks/<noun>.ts` for the parent + `src/commands/tasks/<noun>/<verb>.ts`
  per leaf. R36 has two SIBLING top-level leaves under `tasks` (`share`,
  `unshare`), not a parent + leaves: this matches the `tasks finish` /
  `tasks reopen` shape (sibling pair, no parent).
- `src/ui/human/<resource>-<verb>.ts` — one-line renderer.
- `test/commands/<resource>/<verb>.test.ts` — integration tests with MSW.
- `test/msw/handlers.ts` — append `<resource>Handlers` blocks at the bottom.
- `docs/commands/<resource>-<verb>.md` — user-facing doc per leaf.
- `.changeset/r36-tasks-share.md` — `freelo-cli: minor`.
- README autogen via `pnpm fix:readme`.

## Rationale (one-sentence)

Yellow because the change is purely additive and follows a freshly-validated
template (R35), but adds two new public envelope schemas and crosses a
roadmap-vs-OpenAPI discrepancy that the spec phase must reconcile against
the authoritative API yaml.

## Budget caps in effect

- Wall clock: 30 min
- Agent invocations: 40 (orchestrator counts each Read/Write/Edit/Bash as a
  tool call; non-budgeted)
- Phase retries: 8 cumulative
- Files touched: 25

No overrides applied.
