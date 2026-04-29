# Triage — R26 `freelo files list`

**Run:** 2026-04-29-1756-r26-files-list
**Tier:** Yellow

## Rationale

- Yellow trigger: new user-visible read-only subcommand (additive).
- Yellow trigger: new envelope schema `freelo.files.list/v1` (minor bump).
- No Red triggers: no auth/config/client.ts touch, no breaking change, no dep changes.
- No Green: a brand-new public subcommand is not Green per the rubric ("new user-visible command or flag (additive)" → Yellow).

## Route flags

- `needsSecurityReview`: false (read-only, ACL-server-enforced; standard auth flow)
- `requiresFreeloApi`: true (uses `GET /all-docs-and-files`; full schema in `docs/api/freelo-api.yaml:3909-3954`)
- `preApprovedDeps`: [] (none required — pure code reuse)

## Known scope deviation from roadmap line

The roadmap names `--task <id>` as a filter, but `/all-docs-and-files` accepts only
`projects_ids[]`, `type`, and `p` per OpenAPI `:3925-3937`. Decision logged separately;
follows the R23 precedent of deferring an under-supported filter.

## Stop conditions for this run

- `autoShip: false` → stop at PR open (do not merge).
- Yellow tier → no auto-merge regardless.
