# Requirement — drop keytar

**Run:** 2026-04-26-0747-drop-keytar
**Tier (pre-assigned by user):** Yellow (was a Red trigger; user authorized scope and migration plan, mitigant logged)
**Branch:** `chore/drop-keytar`
**Budget:** default (30m, 40 calls, 8 retries, 25 files)
**`--allow-network`:** false
**`--ship`:** false (auto-merge on green CI)

## Goal

Remove `keytar` (and its transitive `prebuild-install@7.1.3`) from the dep tree. `tokens.json`
(mode `0600`, in `getConfDir()`) becomes the sole persistent token store. Env-var auth
(`FREELO_API_KEY` + `FREELO_EMAIL`) is unchanged and remains the recommended path.

## Why

- `keytar` is orphaned (last release 2022; Electron deprecated 2023).
- `npm install` emits `npm warn deprecated prebuild-install@7.1.3: No longer maintained.`
- Agent-first ethos: env-var auth is the recommended path; keychain was the niche tier.
- Eliminates the only native binding in the tree → more reliable Windows/Linux installs.

## Decided up-front (no orchestrator pause needed)

- **Option C** (drop entirely) over Option B (`@napi-rs/keyring`).
- **Hard cut**, no transitional migration. Existing keychain entries persist harmlessly.
- **Minor bump** (`freelo-cli: minor`) — observable behavior change for keychain users.
- **Yellow tier** despite touching `src/config/` + auth flows; user-authorized scope.

## In-scope file list

See orchestrator brief (this requirement file's parent message). Source: `package.json`,
`src/config/tokens.ts`, `src/config/credentials.ts`, `src/commands/auth/{login,logout,whoami}.ts`,
`src/bin/freelo.ts`. Tests: matching `test/` files plus `test/bin/agent-path.test.ts`. Docs:
`docs/getting-started.md`, `docs/commands/auth-{login,logout,whoami}.md`, CHANGELOG.

## Pause-worthy

- Architect upgrades tier to Red.
- Security auditor returns Critical findings.
- Transitive dep forces keytar back into the lockfile.
- `pnpm install --frozen-lockfile` reports unexpected packages.
- Stuck retry loop (3, same failure).
