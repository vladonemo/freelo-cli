# Decision: Codegen vs hand-written zod schemas (R01)

**Date:** 2026-04-24
**Run:** 2026-04-24-2015-auth-and-agent-first-infra
**Status:** Decided — deferred to R03

---

## Context

R01 requires a typed schema for exactly one Freelo API response: `GET /users/me`.
The question was whether to generate zod schemas from the OpenAPI spec
(`docs/api/freelo-api.yaml`) or write them by hand.

## Inputs considered

1. **Single endpoint.** R01 touches only `GET /users/me`. Spinning up an
   OpenAPI-to-zod pipeline (schema download, codegen invocation, diff review,
   CI integration) for one endpoint is disproportionate overhead.

2. **Spec quality issues.** The `GET /users/me` 401 body (`errors: [{message}]`)
   contradicts the global `ErrorResponse` schema (`errors: string[]`). A
   generator would faithfully reproduce one shape only and miss the inconsistency;
   a hand-written tolerant union (`FreeloErrorBodySchema`) handles both forms and
   documents the quirk explicitly (see spec §3 Quirks 1).

3. **No multi-resource pressure yet.** The value of codegen is proportional to the
   number of endpoints: consistency, no copy-paste drift, free type regeneration on
   spec update. With a single endpoint, these benefits are zero.

4. **Forward-compat already handled.** `.passthrough()` on `UserMeSchema` and
   `UserMeEnvelopeSchema` means the schema survives undocumented fields without
   a codegen regeneration cycle.

## Decision

**Hand-write zod for R01.** No generator, no new tooling dependency.
The hand-written schema (`src/api/schemas/users-me.ts`) is tighter than what a
generator would produce because it explicitly handles the 401 shape discrepancy
and documents the reason for `.passthrough()`.

## Trigger for revisit

**R03 (first multi-endpoint slice).** When two or more distinct API resources
are needed, the drift risk outweighs the setup cost. At that point:
- Evaluate `openapi-zod-client` or equivalent.
- Pin the generator version to the OpenAPI file version in `freelo-api.yaml`.
- Add a CI step that regenerates and diffs on spec change.
- Migrate R01 schemas to generated output if the generator produces
  equivalent or better types.

See also: `.claude/skills/freelo-api/SKILL.md` §Codegen.
