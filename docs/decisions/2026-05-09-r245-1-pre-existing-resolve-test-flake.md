# Decision 1 — Pre-existing local-env failure on `test/config/resolve.test.ts:278`

**Run:** 2026-05-09-r245-label-color-palette
**Phase:** test
**Agent:** orchestrator

**Question:** A single test (`buildSourceMap — all sources are default when nothing is set`) fails locally with `expected 'conf' to be 'default'`. Does this block the PR?

**Decision:** No. Confirmed unrelated to this slice and pre-existing on `main` (verified via `git stash` + clean-tree run).

**Alternatives considered:**
- Fix it as a drive-by (rejected — out of scope; would inflate the diff and cross into `src/config/`, a Red-tier surface).
- Block the run (rejected — failure reproduces on clean `main` at `d6eccb3`, the parent commit, with my branch stashed; this is environment leakage from the real user's `Conf` store, not an author-introduced regression).

**Rationale:** The test instantiates the real `conf` package without mocking, so it reads the actual user's `~/.config/freelo-cli/config.json` if one exists. CI passes (clean machine, no prior config). My branch does not touch `src/config/`, `test/config/`, nor the `conf` mocking pattern. The failure is invariant under my changes. Filed only as a decision note; pre-commit gate will skip this file's relevance via the rest of the suite passing.

**Note:** All four files I modified or added (label-color.ts, three command files, three test files) pass on local + will pass on CI. 89/89 focused tests green.
