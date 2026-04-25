# Triage — 2026-04-25-2034-readme-autocheck

**Tier:** Yellow
**Commit type:** chore

## Summary
Backfill the published `README.md` so it reflects the commands actually shipped in 0.3.1, add a `scripts/check-readme.mjs` doc-drift guard with a CI gate, and add an SDLC-doc rule so doc-writer maintains the autogen block on every public-command change. No runtime, auth, HTTP, schema, or release-tooling change.

## Signals
- [ ] Touches src/commands/ (new/changed subcommand)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [ ] Changes an envelope schema (`freelo.*/vN`)
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [ ] Requires the Freelo API
- [x] Docs-only (plus a developer/CI guard script — internal tooling)
- [x] README content shipped to npm consumers (in `package.json` "files")

## Route flags
- requiresFreeloApi: false
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale
The CLI's user-facing surface (commands, flags, exit codes, schemas) is unchanged. The README, however, is in `package.json` "files", so a new README literally changes what npm publishes — that's user-visible enough to warrant a Yellow tier and a `freelo-cli: patch` changeset. The new dev script (`scripts/check-readme.mjs`) and CI gate are internal tooling. No security-sensitive surface is touched.

## Open concerns
- Architect must decide rendering order (sort alphabetically vs. preserve introspect order). Recommend alphabetic — deterministic and matches current introspect output.
- Architect must decide whether the script invokes `pnpm build` itself or assumes `dist/freelo.js` exists. Recommend the latter (CI runs `pnpm build` already).
- Architect must decide CI matrix coverage (single-row vs. full). Recommend single ubuntu+Node 24 — output is OS-independent given alphabetic determinism.
- Architect must record a decision-log entry on the changeset call (recommend `freelo-cli: patch`).

## Recommended branch name
`chore/readme-autocheck`

---

`TRIAGE run=2026-04-25-2034-readme-autocheck tier=Yellow type=chore flags=[]`
