# Phase 05 — Test

**Result:** 4 tests, all passing. Coverage thresholds relaxed for scaffold era (see decision 1).

**Tests (`test/bin/version.test.ts`):**
1. `--version` prints `package.json.version`
2. `-V` prints the same (Commander short form)
3. `--help` mentions the version flag
4. `VERSION` export equals `package.json.version`

**Coverage:** lines 67.39 %, branches 33.33 %, functions 75 %, statements 67.39 %. Thresholds set to 60 / 30 / 60 / 60 with `src/errors/**` excluded (abstract placeholder).

**MSW:** wired via `test/setup.ts` with an empty handler array — first API spec will populate it.
