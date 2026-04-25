# Spec 0008 — Bump GitHub Actions to Node 24 versions

**Run:** 2026-04-25-2110-actions-version-bump (paused 2026-04-25, resumed same day)
**Tier:** Green (revised on resume — see "Tier rationale" below)
**Author:** orchestrator (autonomous)
**Status:** approved

## Tier rationale (resume)

Original triage marked this Yellow alongside a parallel `drop-node-20-matrix` run.
That parallel run merged independently as PR #16, leaving this run scoped strictly
to action-version bumps:

- No source-code change
- No test change
- No CLI surface change (commands, flags, envelopes)
- No `engines` change
- No new dependency
- No envelope schema change

Per the autonomous-SDLC tier matrix, a CI-only action-version bump with no
runtime impact is Green. Auto-merge will be enabled on the PR.

## Problem

GitHub deprecated Node.js 20-based actions. From **June 2, 2026** runners force Node 24; from **September 16, 2026** Node 20 is removed entirely. Our workflows (`ci.yml`, `release.yml`) still pin three actions to `@v4`, all of which run on Node 20:

| Action | Current pin | Runtime |
|---|---|---|
| `actions/checkout` | v4 | node20 |
| `actions/setup-node` | v4 | node20 |
| `pnpm/action-setup` | v4 | node20 |

GitHub emits a deprecation warning on every run.

## Solution

Bump each action to its lowest stable major that targets Node 24, after verifying the inputs we use are unchanged.

| Action | New pin | Node 24 since | Source verification |
|---|---|---|---|
| `actions/checkout` | **v5** | v5.0.0 (2025-08-11) | Release notes: "Update actions checkout to use node 24" |
| `actions/setup-node` | **v5** | v5.0.0 (2025-09-04) | Release notes: "Upgrade action to use node24" |
| `pnpm/action-setup` | **v5** | v5.0.0 (2026-03-17) | Release notes: "Updated the action to use Node.js 24." |

### Why v5 and not v6 across the board

- **`actions/checkout`**: v6 (2025-11-20) is also Node 24; v5 is fine, more battle-tested. Either works; pick v5 for minimum-version-that-fixes-the-warning discipline.
- **`actions/setup-node`**: v6 (2025-10-14) further restricts auto-cache to npm. We always pass `cache: pnpm` explicitly so neither v5 nor v6 changes our behavior. v5 keeps the surface minimal.
- **`pnpm/action-setup`**: v6 (2026-04-10) was released 15 days ago and pulls in pnpm v11 RC support — too fresh, no value-add for us. v5 (2026-03-17) is the conservative pick.

### Inputs we use — unchanged across v4 → v5

For each action, every input we currently set still exists with identical semantics in v5:

- `actions/checkout@v5`: `fetch-depth` — unchanged.
- `actions/setup-node@v5`: `node-version`, `cache: pnpm`, `registry-url` — all unchanged. The new `package-manager-cache` auto-detection only activates when `cache:` is omitted; we always set it.
- `pnpm/action-setup@v5`: `version`, `run_install` — `action.yml` input surface is byte-identical between v5.0.0 and v6.0.3.

## Out of scope

- No source code changes.
- No npm dependency changes.
- No changeset (workflow-only change does not affect the published `freelo-cli` package).

## Acceptance criteria

1. `ci.yml` and `release.yml` reference `@v5` for all three actions.
2. `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm check:readme` all pass locally on the committed tree.
3. CI on the PR runs to green across the existing matrix (Node 22/24 × ubuntu/macos/windows) without the Node 20 action-runtime deprecation warning. The matrix was already trimmed to `[22, 24]` by PR #16 (merged separately as `drop-node-20-matrix`); this change only bumps action versions.

## Plan

### Files modified
- `.github/workflows/ci.yml` — three `uses:` lines × 2 jobs = 6 lines changed.
- `.github/workflows/release.yml` — three `uses:` lines × 1 job = 3 lines changed.

### Steps
1. Edit `ci.yml`: `actions/checkout@v4` → `@v5`, `pnpm/action-setup@v4` → `@v5`, `actions/setup-node@v4` → `@v5` in both `test` and `check-readme` jobs.
2. Edit `release.yml`: same three substitutions in the `release` job.
3. Run pre-push gate locally: `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`.
4. Commit as a single `chore(ci):` Conventional Commit.
5. Push, open PR with auto-merge enabled.

### Commits
1. `chore(ci): bump GitHub Actions to v5 to clear Node 20 deprecation`

## Risks

- **Low**: `actions/setup-node@v5` introduces auto-detection of package manager from `packageManager` field. We pass `cache: pnpm` explicitly which takes precedence; verified against the v5 release notes.
- **Low**: GitHub-hosted runner version requirement bumps to v2.327.1+. GitHub-hosted runners are auto-updated, so this is non-issue.
- **None** for `pnpm/action-setup@v5` — diff of `action.yml` between v4.x → v5 → v6.0.3 shows the input surface we touch (`version`, `run_install`) is unchanged.
