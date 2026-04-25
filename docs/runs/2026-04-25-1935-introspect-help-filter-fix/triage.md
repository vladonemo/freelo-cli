# Triage — 2026-04-25-1935-introspect-help-filter-fix

**Tier:** Green

## Rationale
- Pure bugfix, no auth/HTTP/config-client/release-tooling touch.
- No new dependencies.
- No breaking changes: envelope schema `freelo.introspect/v1` stays, exit codes
  unchanged, flag names unchanged. The change *adds* successful behavior to a path
  that previously errored — strictly additive in user-visible contract.
- Reviewer expected to find no Blocking items (mechanical 2-line code change in
  `src/lib/introspect.ts` plus one site update in `src/commands/help.ts`).
- Security auditor not triggered (no auth/secrets/IO surface).
- Test coverage easily met (the filter function is purely tested).

## Route flags
- `needsSecurityReview`: false
- `requiresFreeloApi`: false
- `preApprovedDeps`: []
- Changeset bump: `patch`

## Phases scheduled
triage → spec → plan → implement → test → review → doc → PR with auto-merge.

## Risk register
| Risk | Mitigation |
|---|---|
| Hard discipline note re: "claimed green, CI red" | Run `pnpm typecheck && pnpm lint && pnpm test` after every commit, before push |
| Stuck loop | Fix is mechanical; if it loops, pause |
