# freelo-cli

## 0.12.0

### Minor Changes

- 3fda583: feat(commands): add `freelo tasks show <id>` with description, subtasks, and projects side-cars (R08)

  Adds the natural follow-up to R07 — view one task's full detail, with optional
  side-cars for the long-form description, the (paginated) subtask list, and the
  multi-project membership block. Prerequisite for the Wave 2 write commands
  (R09–R15) which need the full task shape to round-trip diffs.

  Public envelope: `freelo.tasks.show/v1`.

  ```
  freelo tasks show <id> [--with description,subtasks,projects]
  ```

  Side-car semantics — every key follows the same "absent vs. present" convention:

  - `data.task` — always present. From `GET /task/{id}`.
  - `data.description` — present only when `--with description` is set; from
    `GET /task/{id}/description`. Tolerates empty descriptions (id/content null).
  - `data.subtasks` — present only when `--with subtasks` is set; from
    `GET /task/{id}/subtasks?p=N` merged across pages via `fetchAllPages`. Empty
    list renders as `[]` (key present, empty array).
  - `data.projects` — present only when `--with projects` is set. **Projected
    from the embedded `multi_project_task` block** in the already-fetched
    `TaskDetail` (decision 1) — no second HTTP call. May legitimately be `null`
    when the task is single-project (key present, value null — distinct from
    absent).

  Why projection instead of a separate GET: the roadmap line for R08 named
  `GET /task/{task_id}/projects` but that endpoint is **not documented** in
  `docs/api/freelo-api.yaml` (only `POST` and `DELETE` exist on that path). The
  documented `TaskDetail.multi_project_task` block answers the same agent
  question. Forward-compatible: if Freelo ever publishes the GET, R08.x can
  swap implementations without changing the envelope shape under
  `data.projects`.

  Also ships:

  - `src/api/schemas/task.ts` — `TaskDetailSchema`, `SubtaskSchema`,
    `TaskCommentSchema`, `MultiProjectBlockSchema`, `TasksShowDataSchema`. Built
    from scratch (not extended from `TaskFull`/`TaskSummary`) because the
    field overlap is partial.
  - `src/api/tasks.ts` — `getTaskDetail`, `getTaskDescription`, `getTaskSubtasks`
    HTTP wrappers, with `signal` / `requestId` plumbing matching R07.
  - `src/ui/human/tasks-show.ts` — TTY renderer for the header block, the
    description block, the subtasks table, and the multi-project membership
    block (or `(single-project task)` note when null).
  - 27 new command-level tests + 14 new wrapper tests covering happy paths,
    validation (no HTTP), every typed error class with exit-code assertion per
    Calibration §1-2, and the `PartialPagesError` mid-stream unwrap path for
    subtasks (Calibration §4 — every new try/catch arm has at least one test).

## 0.11.0

### Minor Changes

- d124392: feat(commands): add `freelo tasks list` across `/all-tasks` and per-tasklist active routes (R07)

  Adds the workhorse read for tasks across the projects you can see.
  The CLI dispatches to one of two Freelo endpoints based on the flag combo:

  - `GET /project/{p}/tasklist/{t}/tasks` when scoped to exactly one
    project + tasklist with no other filter.
  - `GET /all-tasks` for everything else, with bracketed-array filter
    composition (`projects_ids[]`, `with_labels[]`, `due_date_range[*]`).

  Public envelope: `freelo.tasks.list/v1` with `data.endpoint`,
  `data.entity_shape`, and `data.applied_filters` discriminators so
  agents can pin against route-specific entity shapes without guessing.

  Also ships:

  - `src/lib/query.ts` — typed param-map → URL query encoder (handles
    repeating arrays, bracketed objects, scalars, default-false omission).
    Reusable foundation for future write commands.
  - `src/api/tasks.ts` — typed wrappers for both endpoints.
  - `src/api/schemas/task.ts` — Zod schemas for `TaskSummary`,
    `TaskFull`, and `TaskFinished` (the third declared but not wired in
    v1; `tasklist-finished-tasks` route deferred to R07.5).
  - 47 new tests covering happy paths, filter encoding, validation,
    field projection, every typed error class (with exit-code
    assertion per Calibration §1-2), and `--all` mid-stream behaviour.

  Forward-compat: the envelope's `endpoint` discriminator already
  accepts `'tasklist-finished-tasks'` and `entity_shape` accepts
  `'task_finished'`, so the R07.5 finished-tasks slice is purely
  additive (no `/v2` envelope bump).

## 0.10.0

### Minor Changes

- 80803af: Add `freelo tasklists show <id> [--with assignable-workers]` for fetching a
  single tasklist's detail with an optional pool of users you can assign tasks
  to. The `--with assignable-workers` side-car returns a bare `UserBasic[]`
  array (one round-trip — the endpoint is not paginated) and is the natural
  companion to `freelo tasklists list`.

  Introduces the public envelope schema **`freelo.tasklists.show/v1`** with
  `data.tasklist` always present and `data.assignable_workers` present only
  when the side-car was requested (absent — not `null` — otherwise; agents
  detect via `'assignable_workers' in env.data`).

  Backed by `GET /tasklist/{id}` (always) and
  `GET /project/{project_id}/tasklist/{id}/assignable-workers` (under
  `--with assignable-workers`). The user supplies only the tasklist id; the
  command reads `project_id` from the first response to construct the
  side-car URL.

## 0.9.0

### Minor Changes

- ece5235: Add `freelo tasklists show <id> [--with assignable-workers]` for fetching a
  single tasklist's detail with an optional pool of users you can assign tasks
  to. The `--with assignable-workers` side-car returns a bare `UserBasic[]`
  array (one round-trip — the endpoint is not paginated) and is the natural
  companion to `freelo tasklists list`.

  Introduces the public envelope schema **`freelo.tasklists.show/v1`** with
  `data.tasklist` always present and `data.assignable_workers` present only
  when the side-car was requested (absent — not `null` — otherwise; agents
  detect via `'assignable_workers' in env.data`).

  Backed by `GET /tasklist/{id}` (always) and
  `GET /project/{project_id}/tasklist/{id}/assignable-workers` (under
  `--with assignable-workers`). The user supplies only the tasklist id; the
  command reads `project_id` from the first response to construct the
  side-car URL.

## 0.8.1

### Patch Changes

- f79ebfb: R05.5 hardening — three real-world bugs reproduced on `freelo-cli@0.7.0` and
  `0.8.0` against a live Freelo account on 2026-04-26:

  - **Schema:** `UserBasic.fullname` is now `.nullable().optional()`. Live
    Freelo can return user objects without a fullname (deleted users,
    externally-invited pending users, system actors). The strict schema
    rejected these payloads. Same defensive sweep extends to
    `WorkerWithHourRate.fullname` and `HourRate.{amount,currency,is_fixed}`.
  - **Schema:** `Currency.amount` (used by `ProjectFull.real_cost`,
    `ProjectFull.budget`, `TasklistFull.budget`, `TasklistFull.real_cost`)
    now accepts both string and number. Live Freelo returns `amount` as a
    number on multiple endpoints; the prior `z.string()` rejected every
    affected response. The schema normalizes numeric input to a canonical
    string so the public envelope contract (`Currency.amount: string`)
    stays stable.
  - **Errors:** Round-2 fix for the Windows libuv `UV_HANDLE_CLOSING`
    assertion on exit. The 0.5.1 `dispatcher.close()` fix was incomplete —
    on Windows it still tripped on any zod-validation failure exit. We now
    use `dispatcher.destroy()` (forceful) bounded by a 250 ms timeout race,
    and defer `process.exit` via `setImmediate` so libuv has one
    event-loop tick to finalize close callbacks before the synchronous exit.

  No envelope schema bumps. Inbound parser is widened in all three cases;
  output envelope is unchanged.

## 0.8.0

### Minor Changes

- 53a7875: Add `freelo tasklists list [--project <id>]` for browsing tasklists, with the
  same `--page` / `--all` / `--cursor` / `--fields` / `--output` semantics as
  `freelo projects list`.

  Introduces the public envelope schema **`freelo.tasklists.list/v1`** with a
  `data.scope: 'project' | 'all'` discriminator and `data.project_id` echo. Both
  modes back onto the documented `GET /all-tasklists` endpoint
  (`?projects_ids[]=<id>` for the per-project filter).

## 0.7.0

### Minor Changes

- 354555f: Add `freelo projects show <id> [--with workers]`, the second slice of Wave 1
  (R04). Single-resource fetch with optional side-cars; introduces the `--with`
  flag plumbing every later show-style command will inherit.

  New public envelope schema: `freelo.projects.show/v1`. The `data.project`
  payload is the rich `ProjectDetail` shape (extends `ProjectFull` with
  embedded `tasklists[*].tasks` and `workers[*].hour_rate`). When `--with
workers` is set, `data.workers` carries the canonical paginated worker list
  (`UserBasic[]`, no `hour_rate`); absent otherwise.

  `<id>` validates as a positive integer before any HTTP call. Unknown
  `--with` values exit 2 with a `hint_next` listing valid values. 404 and
  403 from `/project/{id}` map to `FREELO_API_ERROR` (exit 4) with friendlier
  hints distinguishing "not found / no access" from "no permission".

  **`--with labels` not shipped.** The original roadmap promised it, but
  Freelo's documented API has no per-project labels read endpoint; only
  workspace-scoped labels are exposed. Tracked as a non-goal in spec 0013;
  will land when Freelo exposes the endpoint or we audit a real account for
  an undocumented one.

## 0.6.0

### Minor Changes

- 6065f80: Drop the `keytar` dependency. `tokens.json` (mode `0600`, in the platform-appropriate
  config directory) is now the sole persistent token store. Env-var auth
  (`FREELO_API_KEY` + `FREELO_EMAIL`) remains the recommended path and is unchanged.

  This eliminates the `prebuild-install@7.1.3` deprecation warning on `npm install`
  and removes the only native binding from the dep tree, making Windows/Linux installs
  binary-free.

  **Behavior change for existing keychain users.** If you previously stored a token in
  the OS keychain (Mac Keychain Access, Windows Credential Manager, libsecret), you'll
  need to re-run `freelo auth login` on first use after upgrade — the token will land
  in `tokens.json`. The old keychain entry persists harmlessly until you remove it
  manually.

  The `FREELO_NO_KEYCHAIN` environment variable is no longer recognized (it was a
  keychain-skip toggle and there is no longer a keychain). Setting it has no effect.

### Patch Changes

- 6065f80: Fix `freelo projects list` against real Freelo accounts on Windows.

  - Schema parser now tolerates `null` on every optional field of project
    response schemas (Freelo returns `client: null`, `tasklists: null`, etc.,
    alongside absent fields). Inbound parser only — envelope schema
    `freelo.projects.list/v1` is unchanged. Repo-wide policy added: every
    optional API response field is also nullable.
  - Top-level error handler now drains undici's global dispatcher before
    `process.exit`, preventing a libuv `UV_HANDLE_CLOSING` assertion
    (`src\\win\\async.c:76`) on Windows when sockets are still being torn down.

## 0.5.1

### Patch Changes

- a24f462: Fix `freelo projects list` against real Freelo accounts on Windows.

  - Schema parser now tolerates `null` on every optional field of project
    response schemas (Freelo returns `client: null`, `tasklists: null`, etc.,
    alongside absent fields). Inbound parser only — envelope schema
    `freelo.projects.list/v1` is unchanged. Repo-wide policy added: every
    optional API response field is also nullable.
  - Top-level error handler now drains undici's global dispatcher before
    `process.exit`, preventing a libuv `UV_HANDLE_CLOSING` assertion
    (`src\\win\\async.c:76`) on Windows when sockets are still being torn down.

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
