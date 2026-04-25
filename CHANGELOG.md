# freelo-cli

## 0.2.0

### Minor Changes

- 4f308dd: feat(config): add full `freelo config` command tree (R02)

  New subcommands: `config list`, `config get`, `config set`, `config unset`,
  `config profiles`, `config use`, `config resolve`.

  **Store schema bump v1 → v2** (additive migration, read-on-load, no write-back):

  - Adds a `defaults` map for output/color/verbose overrides.
  - Old v1 stores are silently migrated in memory; the file is only rewritten on
    the next mutating command.

  **RC file support** (`.freelorc`, `.freelorc.json`, `.freelorc.yaml`):

  - Slotted between environment variables and the conf store.
  - Unknown keys and inline API tokens are rejected with exit 2 (`corrupt-rc`).

  **`ProfileSource` extended** with the new `'rc'` literal.

  **New envelope schemas (public contract)**:

  - `freelo.config.list/v1`
  - `freelo.config.get/v1`
  - `freelo.config.set/v1`
  - `freelo.config.unset/v1`
  - `freelo.config.profiles/v1`
  - `freelo.config.use/v1`
  - `freelo.config.resolve/v1`

  **New runtime dependency**: `cosmiconfig@^9.0.0` for project-level rc file discovery (JSON + YAML).

  **`ProfileSource` extended** with the new `'generated'` literal for runtime-minted values (e.g. auto-generated request IDs).

## 0.1.0

### Minor Changes

- b59956e: R01: Auth commands + agent-first substrate

  Adds `freelo auth login`, `freelo auth logout`, and `freelo auth whoami`
  together with the cross-cutting infrastructure every later slice inherits.

  **New envelope schemas (public contract):**

  - `freelo.auth.login/v1` — result of `freelo auth login`
  - `freelo.auth.logout/v1` — result of `freelo auth logout`
  - `freelo.auth.whoami/v1` — result of `freelo auth whoami`
  - `freelo.error/v1` — structured error envelope on stderr for all failures

  **Global flags** now available on every subcommand:
  `--output auto|human|json|ndjson`, `--color auto|never|always`,
  `--profile <name>`, `-v`/`-vv` verbosity, `--request-id <uuid>`,
  `-y`/`--yes`.

  **Env-first auth** — `FREELO_API_KEY` + `FREELO_EMAIL` bypass the keychain
  entirely. `FREELO_NO_KEYCHAIN=1` forces the fallback file store.

  **Agent-first output** — `--output auto` defaults to `json` when stdout is
  not a TTY; human renderers and spinners are loaded lazily and never executed
  on agent paths.

  **Security:** bumped `undici` from 7.4.0 to >=7.24.0 to resolve 3 High
  advisories (HTTP request smuggling GHSA-2mjp-6q6p-2qxm, CRLF injection via
  upgrade GHSA-4992-7rv2-5pvq, and WebSocket length overflow GHSA-f269-vfmq-vjvj)
  plus 3 Moderate and 1 Low.

- 019c9e8: Initial scaffold of the Freelo CLI: TypeScript + ESM project skeleton, build via tsup, ESLint 9 flat config, Prettier, Vitest with v8 coverage and MSW wired in, Husky + lint-staged + commitlint enforcing Conventional Commits, Changesets for release management, and GitHub Actions CI matrix on Node 20/22 across Linux/macOS/Windows. Ships a single `freelo` binary that responds to `freelo --version` (and `-V`) by printing the package version.
