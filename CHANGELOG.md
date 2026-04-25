# freelo-cli

## 0.5.0

### Minor Changes

- f122dde: Add `freelo projects list` for paginated project listing across five scopes.

  This is the first command that talks to the Freelo API beyond `auth whoami`.
  Selectable via `--scope owned|invited|archived|templates|all` (default `owned`),
  with `--page N` / `--all` / `--cursor <n>` (mutually exclusive) for pagination
  and `--fields a,b,c` for top-level field projection.

  Introduces the `freelo.projects.list/v1` envelope. The `data` payload carries
  an `entity_shape` discriminator (`with_tasklists` for the four sparser scopes,
  `full` for `--scope all`), the resolved `scope`, and the `projects[]` array.
  The envelope's `paging` field is always present — the `/projects` endpoint is
  synthesized as a single page so agents do not need to special-case scopes.

  Adds shared infrastructure used by every future list command: `src/api/pagination.ts`
  (`NormalizedPage`, `fetchAllPages`, `projectFields`) and `src/ui/table.ts` (lazy
  `cli-table3` renderer for human mode).

  Schema commitment: `freelo.projects.list/v1` is a public contract. Field
  removal, rename, or retype is breaking.

## 0.4.0

### Minor Changes

- f3f8cd0: Include the `help` subcommand in `freelo --introspect` (and in `freelo help --output json`) `data.commands`. Previously omitted by design; now enumerated symmetrically with every other public command, with `output_schema: "freelo.introspect/v1"` (self-referential — `freelo help --output json` emits exactly that envelope). Additive content change to the `freelo.introspect/v1` envelope; no shape change. README autogen Commands block regenerated to include the new row. (Spec 0008.)

## 0.3.2

### Patch Changes

- df4463a: Backfill `README.md` to reflect the commands shipped in 0.3.1 (auth login/logout/whoami,
  config list/get/set/unset/profiles/use/resolve, plus `--introspect` and `help --output json`),
  replacing the stale "early scaffold — only `freelo --version` exists" status line. The
  Commands section is now generated from a live `freelo --introspect` envelope and verified
  in CI by `pnpm check:readme` so it can never drift again.

## 0.3.1

### Patch Changes

- 0ff0392: Fix `freelo help <parent-group> --output json` so it returns the introspect
  envelope scoped to the parent's subtree instead of failing with
  `VALIDATION_ERROR: Unknown command '<parent>'` exit 2.

  Previously the filter did an exact-match against `commands[].name`, but the
  introspect data only stores leaves — so any non-leaf path (`help config`,
  `help auth`) errored out. The filter now matches both leaves and parent-group
  prefixes, returning every leaf under the requested subtree. Existing leaf and
  unknown-path behavior is unchanged. The `freelo.introspect/v1` envelope schema
  is unchanged (no schema bump).

## 0.3.0

### Minor Changes

- e5cf9d1: Add `freelo --introspect` and `freelo help --output json` (R02.5).

  Agents and CI scripts can now enumerate the entire CLI surface programmatically — every command, flag, argument, output schema, and `destructive` boolean — as a single `freelo.introspect/v1` envelope. The introspector walks the live Commander tree, so future commands light up automatically with no hand-maintained list.

  - `freelo --introspect` — single JSON envelope to stdout, one line, exit 0. Loads no human-UX dependencies.
  - `freelo help --output json` — agent-friendly alias for the full envelope.
  - `freelo help <command...> --output json` — scoped to a single leaf.
  - Every leaf command file now exports `meta: CommandMeta` (`{ outputSchema, destructive }`), type-checked at compile time.

  New envelope schema: `freelo.introspect/v1`. No existing schemas changed.

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
