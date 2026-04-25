# Phase 3 — Plan

7 files (5 new, 2 modify):

| File | Change |
|---|---|
| `scripts/check-readme.mjs` | new |
| `test/scripts/check-readme.test.ts` | new |
| `README.md` | modify (status line + autogen block) |
| `.github/workflows/ci.yml` | modify (new `check-readme` job) |
| `.claude/docs/sdlc.md` | modify (Phase 6 rule) |
| `package.json` | modify (`check:readme` + `fix:readme` aliases) |
| `.changeset/readme-autocheck.md` | new (`freelo-cli: patch`) |

No new dependencies. Test strategy: vitest with `spawnSync(node, scriptPath)` and `FREELO_README_REPO_ROOT` pointing at a tempdir.

Rollout: single PR, two commits.
