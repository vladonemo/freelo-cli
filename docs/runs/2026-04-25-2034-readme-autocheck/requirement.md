# Requirement — 2026-04-25-2034-readme-autocheck

## Origin
Operator-initiated autonomous run.

## Verbatim input
The README on npmjs.com for `freelo-cli@0.3.1` still says "early scaffold — only `freelo --version` exists." That is wrong: 0.3.1 ships auth (login/logout/whoami), config (list/get/set/unset/profiles/use/resolve), and introspect (`--introspect`, `help --output json`). Root cause is process drift: `.claude/docs/sdlc.md` Phase 6 has no rule about README maintenance.

Three coordinated outputs in one PR:

1. Backfill `README.md` to reflect what shipped in 0.3.1, with an autogen Commands block delimited by `<!-- BEGIN AUTOGEN COMMANDS -->` / `<!-- END AUTOGEN COMMANDS -->`. Sourced deterministically from `dist/freelo.js --introspect`.
2. Add `scripts/check-readme.mjs` (default = CI mode, `--write` = developer rewrite). Consumes existing `dist/freelo.js`. Verifies the autogen block matches the live introspect envelope.
3. Wire `pnpm check:readme` into CI after `pnpm build`. Single Linux + Node 24 row is enough (alphabetic determinism makes it OS-independent).
4. Update `.claude/docs/sdlc.md` Phase 6 to mandate the autogen block when public commands change.

## Run flags
- Budget: default (30m / 40 calls / 8 retries / 25 files)
- --allow-network: false
- --ship: false

## Out of scope
- Don't change introspect schema/behavior.
- Don't change publish/release tooling.
- Don't touch `engines.node`.
- Don't add `help` to the autogen block (intentionally excluded by introspect).

## Branch
`chore/readme-autocheck` off `main` at `b34ad84`.

## Discipline carryover
After every commit and before push, run the full gate:
`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
Push is the last action; failures fix-and-recommit, never claim green on stale.
