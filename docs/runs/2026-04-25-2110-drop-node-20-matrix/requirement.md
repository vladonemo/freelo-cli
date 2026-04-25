# Run requirement — 2026-04-25-2110-drop-node-20-matrix

Node 20 reaches end-of-life on April 30, 2026 (5 days from today). Drop it from
the CI test matrix in `.github/workflows/ci.yml` so we stop spending CI minutes
testing an EOL runtime.

**Current matrix:** `node: [20, 22, 24]` — drop to `[22, 24]`.

## Critical scope boundary

**Do NOT bump `engines.node` in `package.json`.** That is a separate, deliberate,
user-gated decision (semver-relevant) that must not piggyback on a CI-cleanup
chore. Preserve `engines.node: ">=20.11.0"`.

## Run flags

- Tier: Yellow (CI matrix; reduces test coverage of an about-to-EOL runtime).
- Budget: default (30m, 40 calls, 8 retries, 25 files).
- `--allow-network`: false.
- `--ship`: false.

## Branch

`chore/drop-node-20-from-matrix` off `main` (currently `581bd46`).
