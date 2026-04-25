# Phase 5 — Test

`test/scripts/check-readme.test.ts` — 7 cases, all green:

1. Match → exit 0.
2. Stale block → exit 1, diff on stderr, mentions `pnpm fix:readme`.
3. `--write` rewrites README, second invocation reports up-to-date.
4. Missing markers → exit 2 with marker name in stderr.
5. Missing `dist/freelo.js` → exit 2 with build hint.
6. Multi-group rendering: `### auth` precedes `### config`, all commands present.
7. Optional + variadic args: `<req> [opt] [rest...]` rendered correctly; empty description omits the em-dash.

Test runtime: ~1.7s for the file. Full suite still 527/527 passing.
