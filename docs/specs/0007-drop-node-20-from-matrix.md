# Spec 0007 — Drop Node 20 from CI test matrix

**Run:** 2026-04-25-2110-drop-node-20-matrix
**Tier:** Yellow
**Status:** Implemented

## Problem

Node.js 20 reaches end-of-life on **2026-04-30** (5 days after this run starts).
The CI matrix in `.github/workflows/ci.yml` currently exercises Node 20, 22, and
24 across three operating systems (9 jobs per push). Continuing to test against
an EOL runtime spends CI minutes verifying a target the upstream Node project
will no longer patch — and any failures uniquely surfaced by Node 20 from this
point forward are issues we would not act on.

## Goal

Stop spending CI on Node 20 by removing `20` from the matrix, while preserving
the project's stated runtime support (`engines.node: ">=20.11.0"`) until that
support claim is changed in a separate, deliberate, user-gated release.

## Non-goals

- **Not** bumping `engines.node`. The runtime declaration in `package.json`
  is a public, semver-relevant promise and a different decision from internal
  CI coverage. See decision-log entry 1.
- **Not** changing the matrix on the macOS/Windows/Ubuntu axis.
- **Not** changing the `check-readme` job (it pins Node 24 already).
- **Not** touching any source under `src/`, any docs under `docs/`, or any
  test under `test/`.

## Acceptance criteria

1. `.github/workflows/ci.yml` has `node: [22, 24]` on the `test` job's matrix.
2. `package.json` `engines.node` is unchanged (`">=20.11.0"`).
3. `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`
   all pass locally before push.
4. PR body explicitly notes that this is **CI-internal only** and does **not**
   alter the supported Node range advertised to consumers.

## Plan

### Files modified

| Path | Change |
|---|---|
| `.github/workflows/ci.yml` | matrix `node: [20, 22, 24]` → `node: [22, 24]` |
| `docs/runs/2026-04-25-2110-drop-node-20-matrix/*.md` | run artifacts |
| `docs/specs/0007-drop-node-20-from-matrix.md` | this spec |
| `docs/decisions/2026-04-25-2110-drop-node-20-matrix-1-defer-engines-bump.md` | decision log |

No `src/` changes. No `package.json` change. No new dependencies. No changeset
(see decision-log entry 2 — CI-internal change is not a user-visible delta).

### Commits

- `chore(ci): drop Node 20 from test matrix`
  - Modifies the matrix line only; no other changes in `ci.yml`.
- `docs(sdlc): record run 2026-04-25-2110-drop-node-20-matrix artifacts`
  - Spec, decisions, run dir.

### Gate before push

`pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme`

### PR

Title: `chore(ci): drop Node 20 from test matrix`. Body explicitly calls out
that `engines.node` is preserved and the engines bump is a separate decision
queued for a future minor/major. Auto-merge `--squash` enabled if available.

## Risks

- **Low.** Tests are runtime-agnostic; the surface they validate is the same
  on Node 22 and 24 as it was on 20. Loss of Node-20-specific regression
  detection is the explicit, accepted trade-off.
- **Possible merge conflict** with the parallel `actions-version-bump` run on
  the same file. Trivially three-way mergeable (single matrix-line edit).

## Open questions

None.
