---
name: release-workflow
description: Changesets-based release workflow for the Freelo CLI — writing changesets, CI config, npm publish, GitHub Releases. Load when shipping, bumping, or debugging a release.
---

# Release workflow

The CLI ships via [changesets](https://github.com/changesets/changesets) → npm → GitHub Releases. Humans write intent (changesets); the action does the mechanics (bump + changelog + publish).

## Writing a changeset

```bash
pnpm changeset
```

Interactive flow asks:
1. Which packages changed (just the one in a single-package repo).
2. Bump level: `patch` / `minor` / `major`.
3. A one-paragraph summary for the changelog.

Result: a Markdown file under `.changeset/<random-name>.md`. Commit it with your PR.

### What the summary should say

- **User-facing** language: what changed from their perspective, not how.
- Include the exact subcommand or flag when relevant: `` `freelo tasks list` now supports `--status completed` ``.
- Skip implementation detail.

Good: `` Fixed `freelo auth status` showing "expired" when the token was valid but the clock was skewed. ``

Bad: `Fix JWT clock skew handling in src/config/auth.ts`.

### SemVer mapping

| Change | Bump |
|--------|------|
| New subcommand or flag | `minor` |
| New field in `--json` output | `minor` |
| Bug fix, no behavior change for correct usage | `patch` |
| Removed/renamed flag, changed `--json` schema, changed exit code | `major` (pre-1.0: `minor` + loud changelog) |
| Docs-only, internal refactor | no changeset — or `patch` if you want to cut a release anyway |

## CI workflow

`.github/workflows/release.yml`:

```yaml
name: Release
on:
  push:
    branches: [main]

jobs:
  release:
    runs-on: ubuntu-latest
    permissions:
      contents: write
      pull-requests: write
      id-token: write   # for npm provenance
    steps:
      - uses: actions/checkout@v4
        with: { fetch-depth: 0 }
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          registry-url: https://registry.npmjs.org
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      - run: pnpm build
      - uses: changesets/action@v1
        with:
          publish: pnpm release
          version: pnpm changeset version
          title: 'chore: version packages'
          commit: 'chore: version packages'
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
          NPM_CONFIG_PROVENANCE: 'true'
```

`pnpm release`:

```json
{
  "scripts": {
    "release": "pnpm build && changeset publish"
  }
}
```

## The Version Packages PR

On every push to `main`, the action either opens or updates a PR titled "chore: version packages" containing:

- The bumped `package.json`
- A rewritten `CHANGELOG.md`
- Deletion of the consumed changesets

**Review it**: polish the changelog, squash near-duplicates. When you merge, the next run publishes.

## Tagging and GitHub Release

The `changesets/action` creates a git tag (`v1.2.3`) and a GitHub Release with the changelog section — automatically, on publish success.

Do **not** tag manually before publish. A failed publish would leave a lying tag.

## npm provenance

With `NPM_CONFIG_PROVENANCE=true` and the `id-token: write` permission, npm records build provenance from GitHub Actions. Users can verify with `npm audit signatures`.

Provenance requires publishing from a public repo with OIDC. If the repo is private, drop provenance and document it.

## Post-release checks

1. `npx freelo-cli@latest --version` — matches the new version
2. `npx freelo-cli@latest --help` — runs clean on a fresh machine (CI has a matrix job for this)
3. `npm view freelo-cli dist-tags` — `latest` points at the new version

If any fail, investigate immediately. Don't `unpublish`:

```bash
npm deprecate freelo-cli@X.Y.Z "Use X.Y.(Z+1); <one-line reason>"
```

Then ship the fix through the normal flow.

## Hotfix flow

Still goes through a PR, changeset, and Version Packages PR. The difference: branch from the latest release tag, not `main`, if `main` has unshippable work in progress. Cherry-pick the fix forward afterward.

## What breaks this flow

- **Local publishes.** The registry accepts them; CI can't enforce provenance. Never run `npm publish` from a dev machine.
- **Skipping changesets.** A release with no changeset since the last version does nothing — the action sees no pending changes.
- **Force-pushing `main`.** Don't. It orphans tags and changelogs.
