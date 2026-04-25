# Triage — 2026-04-25-2110-help-introspect-meta

**Tier:** Yellow
**Decision:** Option A (include `help` in `data.commands`).

## Rationale

- Architect picks Option A: spec is the contract; self-referential `help` entry
  is standard for CLI introspection; agent tools benefit from completeness.
- Tier Yellow because the change adds content to a published envelope schema's
  payload (additive, backwards-compatible) and modifies the README autogen
  Commands block. No existing field is removed/renamed/retyped.
- No new dependencies. No auth/config/HTTP touch. No security review trigger.

## Route flags

- `needsSecurityReview`: false
- `requiresFreeloApi`: false
- `preApprovedDeps`: []

## Affected surfaces

- `src/commands/help.ts` — attach `meta` via `attachMeta()`.
- `test/fixtures/introspect-golden.json` — add the new `help` entry (snapshot
  auto-updated by `vitest -u`).
- `test/ui/introspect.test.ts` — flip the "does not emit help" assertion to
  the inverse.
- `README.md` — autogen Commands block regenerated via `pnpm fix:readme`.

No source-of-truth schema change (`freelo.introspect/v1` shape unchanged).
