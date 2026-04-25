# Phase 4 — Implement

`scripts/check-readme.mjs` — pure Node built-ins. Spawns `dist/freelo.js --introspect`, parses envelope, validates `schema === 'freelo.introspect/v1'`, renders the autogen block (alphabetic group + alphabetic intra-group), splices between markers, compares with CRLF→LF normalization. `--write` rewrites in place.

`package.json` — added `check:readme` and `fix:readme` scripts.

No retries: typecheck, lint, build all clean on first attempt.

Rollout amended to a single atomic commit (rather than the 2-commit plan in §Plan): the gate `pnpm check:readme` would have failed on commit 1's tree if shipped split. Atomic keeps every commit on the branch green and bisect-clean.
