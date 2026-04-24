# Freelo CLI — Incremental delivery roadmap

> Source of truth: `docs/api/freelo-api.yaml` (108 operations, 17 resource tags).
> This doc slices that surface into requirements a contributor can pick up one at a time. Each requirement is a **vertical slice**: args → authenticated HTTP → zod-validated response → enveloped renderer → exit code. No requirement leaves the user with a half-wired subsystem.
>
> The CLI is **agent-first** (see `.claude/docs/architecture.md` §Audience). Every slice below inherits: JSON envelope output when non-TTY, structured error envelope, typed exit codes, env-first auth, `--dry-run` on writes, batch input (`--id` / `--ids` / `--stdin`), and idempotent no-op on absorbing-state writes. The infra for those lands in R01; later slices only add command-specific logic.

## Slicing principles

1. **Every slice ships a command a user can run and get value from.** "Add the HTTP client" is not a slice; "`freelo auth login` works" is. Infrastructure rides in on the first slice that needs it.
2. **Read before write, write before destructive, scalar before bulk.** The happy path is exercised long before the scary ones.
3. **Cross-cutting concerns arrive once and only once.** Flag policy (`--output`, `--profile`, `--yes`, `--dry-run`), envelope schema contract, pagination, confirmation, editor/stdin input, batch/NDJSON — each is introduced by one named slice and reused by the rest.
4. **Each wave ends with a coherent product.** After Wave N, a real user can do a real job. We could ship to npm at the end of any wave and it would stand on its own.
5. **Small enough to spec in one `/spec` pass.** A slice should fit in ~1 spec file, ~5–15 files of code, ~20–60 minutes of review.

## Wave overview

| Wave | Theme | Cumulative user value | Slices |
|---|---|---|---|
| 0 | Auth + infra foundation | Log in (env or prompt), agents can drive the CLI via JSON envelopes, command surface is introspectable | R01–R02, R02.5 |
| 1 | Read-only essentials | Browse your projects, tasklists, and tasks from the terminal | R03–R08 |
| 2 | Task lifecycle | Daily-driver: create, edit, move, finish, reopen, delete tasks; manage subtasks and descriptions | R09–R15 |
| 3 | Collaboration | Comments + time tracking + work reports — collaborate and log work without the web UI | R16–R22 |
| 4 | Labels, files, notifications | Organize, attach files, stay on top of what changed | R23–R28 |
| 5 | Project admin | Create projects, manage workers, archive/activate, templates | R29–R34 |
| 6 | Advanced task surface | Reminders, public links, estimates, relations, multi-project | R35–R39 |
| 7 | Custom fields + notes + pins | Structured extensions and per-project knowledge | R40–R44 |
| 8 | Invoicing + audit + search + reference | Reporting, audit trail, fulltext, enum lookups | R45–R50 |

Dependency rule: a slice may only depend on earlier-numbered slices. Most slices only depend on R01/R02 (auth + list infra).

---

## Wave 0 — Auth & infra (the floor)

Goal after this wave: a user can authenticate and confirm "who am I." Everything else becomes a thin command on top.

### R01 — `freelo auth login` / `logout` / `whoami` + agent-first infra
**Outcome:** Agents and humans both authenticate; agents via env vars without any prompt, humans via interactive login. `whoami` verifies the credentials. All subsequent slices inherit this slice's infra.
**Endpoints:** `GET /users/me` (credential verification).
**CLI:**
```
freelo auth login [--email <e>] [--profile <name>] [--api-key-stdin]   # TTY prompts when no --api-key-stdin
freelo auth logout [--profile <name>]
freelo auth whoami [--profile <name>]                                   # respects --output auto|human|json|ndjson

# Agent-style (zero-prompt):
FREELO_EMAIL=me@x FREELO_API_KEY=... freelo auth whoami --output json
```
**Ships with this slice (arrives here, reused everywhere):**
- **HTTP client** (`src/api/client.ts`): `undici` with Basic Auth, `User-Agent: freelo-cli/<version>`, `Accept: application/json`, `AbortSignal` threading, jittered 429 retry (GETs only, max 3), rate-limit header capture on every response.
- **Credential precedence**: `--api-key-stdin` > `FREELO_API_KEY`+`FREELO_EMAIL` > `keytar` keychain > `conf` file. Keychain skipped entirely when env is set or `FREELO_NO_KEYCHAIN=1`.
- **Non-secret config** via `conf` + `cosmiconfig`; frozen `AppConfig` at startup.
- **Global flags** on root program: `--output <auto|human|json|ndjson>` (default `auto`), `--color <auto|never|always>`, `--profile <name>`, `-v / -vv`, `--request-id <uuid>`, `--yes / -y`.
- **Output pipeline** (`src/ui/envelope.ts`): versioned envelope builder with `schema`, `data`, `paging?`, `rate_limit?`, `request_id?`; `json` / `ndjson` / `human` renderers; TTY detection in `src/lib/env.ts`.
- **Error taxonomy** (`src/errors/`): `BaseError`, `FreeloApiError`, `ConfigError`, `ValidationError`, `NetworkError`, `ConfirmationError`, `RateLimitedError` — all with stable `code`, `exitCode`, `retryable`, optional `httpStatus` / `requestId` / `hintNext`. `handleTopLevelError` emits a `freelo.error/v1` envelope to stderr in non-TTY / `json` mode.
- **Exit codes**: `0` success (incl. idempotent no-op), `1` generic, `2` usage / `CONFIRMATION_REQUIRED`, `3` auth, `4` Freelo API, `5` network, `6` rate-limited, `130` SIGINT.
- **Logging**: `pino` default silent; `-v` info, `-vv` debug; stderr only; `pino-pretty` lazy-loaded in TTY.
- **Lazy human-UX imports**: `@inquirer/prompts`, `ora`, `boxen`, `cli-table3`, `chalk`, `pino-pretty`, `update-notifier` are all `await import(...)`-loaded; ESLint rule bans top-level static imports of these.
- **Codegen decision** (see freelo-api SKILL.md §Codegen) made here and recorded in `docs/decisions/`.
**Depends on:** —

### R02 — `freelo config` surface
**Outcome:** User or agent inspects / switches profiles, sees the merged effective config (with each setting's source), sets defaults without re-running `auth login`.
**Endpoints:** none (local config only).
**CLI:**
```
freelo config list
freelo config get <key>
freelo config set <key> <value>
freelo config unset <key>
freelo config profiles
freelo config use <profile>
freelo config resolve [--show-source]      # merged effective config, secrets redacted,
                                            # each value annotated with source (flag/env/rc/conf/default)
```
**Ships with this slice:** `cosmiconfig` loader for project-level `.freelorc.*`; precedence already defined in R01 (flag > env > project rc > user conf > default). `config resolve` is essential for agents debugging drift.
**Depends on:** R01.

### R02.5 — `freelo --introspect` (command-tree discovery)
**Outcome:** An agent can enumerate the entire CLI surface programmatically — every command, subcommand, flag, arg, output schema name, and destructive flag — without parsing `--help` text.
**Endpoints:** none (local — walks the Commander program tree).
**CLI:**
```
freelo --introspect                          # single JSON envelope to stdout
freelo help --output json                    # same content; agent-friendly alias
freelo help <cmd> --output json              # scoped to one command
```
**Output schema:** `freelo.introspect/v1` — `{ version, commands: [{ name, description, args, flags: [{ name, short, type, required, description, repeatable }], output_schema, destructive }] }`.
**Ships with this slice:**
- `src/lib/introspect.ts` — Commander tree walker.
- Every command file is expected to declare `meta: { outputSchema, destructive }` (type-checked) so introspection is generated, never hand-maintained.
- Golden-file test in `test/ui/introspect.test.ts` locks the envelope shape; future command additions update the golden.
**Depends on:** R01.
**Why this slice is separate:** it's tiny and landing it early means every later slice automatically shows up in tool-use manifests (MCP, Claude Code tool registries, etc.) with zero extra work.

---

## Wave 1 — Read-only essentials

Goal after this wave: the CLI is a legitimate read replacement for the Freelo web UI's most-used views.

### R03 — `freelo projects list`
**Outcome:** See your active projects, paginated and filterable.
**Endpoints:** `GET /projects`, `GET /all-projects`, `GET /invited-projects`, `GET /archived-projects`, `GET /template-projects`.
**CLI:**
```
freelo projects list [--scope owned|invited|archived|templates|all] [--page N | --all]
                     [--fields id,name,state,date_start]```
**Ships with this slice (infra):**
- `src/api/pagination.ts` — normalizes `{ total, count, page, per_page, data: { <resource>: [] } }` → `{ data, page, perPage, total, nextCursor }`; `paging` field emitted into the envelope.
- `--page N` / `--all` / `--cursor <n>` semantics (client-side iteration until `nextCursor === undefined`).
- `src/ui/table.ts` (cli-table3, lazy-loaded) for `human` mode; envelope + JSON / NDJSON renderers already land in R01.
- `--fields a,b,c` projection applied before rendering.
- `ProjectListSchema` in `src/api/schemas/project.ts`.
- Output schema: `freelo.projects.list/v1`.
**Depends on:** R01.

### R04 — `freelo projects show <id>`
**Outcome:** See one project's full metadata, workers, and labels.
**Endpoints:** `GET /project/{id}`, `GET /project/{id}/workers`.
**CLI:** `freelo projects show <id> [--with workers,labels]`
**Depends on:** R03.

### R05 — `freelo tasklists list`
**Outcome:** List tasklists, scoped to a project or across all projects.
**Endpoints:** `GET /project/{project_id}/tasklists`, `GET /all-tasklists`.
**CLI:** `freelo tasklists list [--project <id>] [--page N|--all]`
**Depends on:** R03.

### R06 — `freelo tasklists show <id>`
**Outcome:** Tasklist detail + assignable workers.
**Endpoints:** `GET /tasklist/{tasklist_id}`, `GET /project/{project_id}/tasklist/{tasklist_id}/assignable-workers`.
**CLI:** `freelo tasklists show <id> [--with assignable-workers]`
**Depends on:** R05.

### R07 — `freelo tasks list`
**Outcome:** The workhorse read — filter tasks across all accessible projects.
**Endpoints:** `GET /all-tasks`, `GET /project/{project_id}/tasklist/{tasklist_id}/tasks`, `GET /tasklist/{tasklist_id}/finished-tasks`.
**CLI:**
```
freelo tasks list [--project <id>]... [--tasklist <id>]... [--worker <id>]
                  [--state <id>] [--label <name>]... [--without-label <name>]
                  [--due-from YYYY-MM-DD] [--due-to YYYY-MM-DD] [--no-due]
                  [--finished-overdue] [--finished-from ...] [--finished-to ...]
                  [--search <text>] [--order-by priority|name|date_add|date_edited_at]
                  [--order asc|desc] [--page N|--all] [--fields ...]```
**Ships with this slice:**
- `src/lib/query.ts` — encodes array params as `projects_ids[]=...` repeating, not PHP-brackets-in-key.
- Explicit handling of the `with_label` (deprecated, singular) vs `with_labels[]` merge quirk — CLI normalizes to the array form.
**Depends on:** R03.

### R08 — `freelo tasks show <id>`
**Outcome:** Full task view: metadata, description, subtasks, labels.
**Endpoints:** `GET /task/{task_id}`, `GET /task/{task_id}/description`, `GET /task/{task_id}/subtasks`, `GET /task/{task_id}/projects`.
**CLI:** `freelo tasks show <id> [--with description,subtasks,projects]`
**Depends on:** R07.

---

## Wave 2 — Task lifecycle (daily-driver writes)

Goal after this wave: the CLI is a legitimate write replacement for the most common task workflow.

### R09 — `freelo tasks create`
**Outcome:** Create a task in a tasklist, with workers, label, due date, description. First write slice — brings the shared write-infra that every later write uses.
**Endpoints:** `POST /project/{project_id}/tasklist/{tasklist_id}/tasks`.
**CLI:**
```
freelo tasks create --tasklist <id> --name <str> [--worker <id>]... [--due YYYY-MM-DD]
                    [--priority low|normal|high] [--label <name>]...
                    [--description <text>|--description-file <path>|--editor]
                    [--dry-run]
# Batch:
freelo tasks create --stdin --tasklist <id>   # NDJSON lines, one task per line
```
**Ships with this slice:**
- POST request schema + body builder pattern.
- **Shared write mixin** (`src/lib/dry-run.ts`, `src/lib/batch.ts`): `--dry-run`, `--id` / `--ids` / `--stdin` NDJSON reader, NDJSON output streamer. All later writes use this.
- Output schema: `freelo.tasks.create/v1`. In `--dry-run` or batch mode, envelope carries `dry_run: true` or streams one envelope per input line.
**Depends on:** R07.

### R10 — `freelo tasks edit <id>`
**Outcome:** Partial update of a task (name, due date, workers, priority, labels).
**Endpoints:** `PATCH /task/{task_id}` (or the spec's edit verb), `POST /task-labels/add-to-task/{task_id}` and `/remove-from-task/{task_id}` for label diff.
**CLI:** same flags as `tasks create` where overlapping, plus `--add-label`, `--remove-label`.
**Depends on:** R09.

### R11 — `freelo tasks finish` / `tasks reopen`
**Outcome:** State transitions from the terminal. First absorbing-state writes — introduces the shared idempotency handler.
**Endpoints:** `POST /task/{task_id}/finish`, `POST /task/{task_id}/activate`.
**CLI:**
```
freelo tasks finish <id>... [--dry-run]
freelo tasks reopen <id>... [--dry-run]
freelo tasks finish --ids a,b,c                # batch
freelo tasks finish --stdin                    # NDJSON in, NDJSON out
```
**Ships with this slice:**
- `src/lib/idempotency.ts` — helper that detects "already in target state" responses (or pre-checks state) and returns a success envelope with `already_in_target_state: true`. Reused by `archive`, `activate`, mark-read/unread, attach/detach-label, delete-by-id.
- Output schemas: `freelo.tasks.finish/v1`, `freelo.tasks.reopen/v1`.
**Depends on:** R09.

### R12 — `freelo tasks move <id>`
**Outcome:** Move a task between tasklists, optionally cross-project.
**Endpoints:** `POST /task/{task_id}/move/{tasklist_id}`.
**CLI:** `freelo tasks move <id> --to-tasklist <id> [--to-project <id>]`.
**Depends on:** R10.

### R13 — `freelo tasks delete <id>`
**Outcome:** Soft-delete a task. First destructive op — introduces the shared confirmation helper.
**Endpoints:** `DELETE /task/{task_id}`.
**CLI:** `freelo tasks delete <id>... [--yes] [--dry-run]` / `--ids` / `--stdin`.
**Ships with this slice:**
- `src/lib/confirm.ts` — `--yes` bypass, interactive prompt via lazy-imported `@inquirer/prompts` on TTY, **throws `ConfirmationError` (exit 2, `code: CONFIRMATION_REQUIRED`)** in non-TTY without `--yes`. Never hangs.
- Reused by every destructive command in later waves.
- Output schema: `freelo.tasks.delete/v1`.
**Depends on:** R09, R11 (for idempotent "already deleted" handling).

### R14 — `freelo subtasks` (smart list)
**Outcome:** Inspect and add subtasks (taskchecks).
**Endpoints:** `GET /task/{task_id}/subtasks`, `POST /task/{task_id}/subtasks`.
**CLI:**
```
freelo subtasks list --task <id>
freelo subtasks add --task <id> --name <str> [--worker <id>] [--due YYYY-MM-DD]
```
**Notes:** The POST endpoint auto-falls-back from smart subtask to simple taskcheck when the tasklist can't host smart ones — surface this in help text.
**Depends on:** R08.

### R15 — `freelo tasks description`
**Outcome:** Get or replace a task's rich description from the terminal.
**Endpoints:** `GET /task/{task_id}/description`, `POST /task/{task_id}/description` (upsert).
**CLI:**
```
freelo tasks description get <id>freelo tasks description set <id> (--from-file <path> | --editor | -)   # `-` = stdin
```
**Depends on:** R09.

---

## Wave 3 — Collaboration: comments, time, work reports

Goal after this wave: the CLI replaces the Freelo web UI for 80% of individual-contributor daily use.

### R16 — `freelo comments list`
**Endpoints:** `GET /task/{task_id}/comments`, `GET /all-comments`.
**CLI:** `freelo comments list [--task <id>] [--project <id>] [--since DATE] [--page N|--all]`.
**Depends on:** R08.

### R17 — `freelo comments add`
**Endpoints:** `POST /task/{task_id}/comments`.
**CLI:** `freelo comments add --task <id> (--message <str>|--from-file <path>|--editor|-)`.
**Depends on:** R16, R15 (editor pattern).

### R18 — `freelo comments edit` / `comments delete`
**Endpoints:** `PATCH /comment/{comment_id}`, `DELETE /comment/{comment_id}`.
**CLI:** `freelo comments edit <id> …` / `freelo comments delete <id> [--yes]`.
**Depends on:** R17, R13 (confirm).

### R19 — `freelo time start` / `time status`
**Outcome:** Start tracking on a task; check current status.
**Endpoints:** `POST /timetracking/start`, `GET /timetracking/status`.
**CLI:** `freelo time start --task <id> [--note <str>]` / `freelo time status`.
**Ships with this slice:** friendly formatting of the "already tracking X since Y" error — time tracking is singleton per user.
**Depends on:** R08.

### R20 — `freelo time stop` / `time edit`
**Endpoints:** `POST /timetracking/stop`, `PATCH /timetracking/edit`.
**CLI:** `freelo time stop [--note <str>]` / `freelo time edit [--note <str>] [--started-at <ISO>]`.
**Depends on:** R19.

### R21 — `freelo reports list`
**Outcome:** Browse work reports (time entries) with filters.
**Endpoints:** `GET /work-reports`, `GET /task/{task_id}/work-reports`.
**CLI:** `freelo reports list [--task <id>] [--project <id>] [--worker <id>] [--from DATE] [--to DATE] [--page N|--all]`.
**Depends on:** R07.

### R22 — `freelo reports log` / `reports edit` / `reports delete`
**Outcome:** Log work directly (without a live timer) and amend / remove entries.
**Endpoints:** `POST /task/{task_id}/work-reports`, `PATCH /work-reports/{id}`, `DELETE /work-reports/{id}`.
**CLI:**
```
freelo reports log --task <id> --minutes <n> [--date YYYY-MM-DD] [--note <str>]
freelo reports edit <id> [--minutes <n>] [--note <str>] [--date YYYY-MM-DD]
freelo reports delete <id> [--yes]
```
**Ships with this slice:** currency/money helper if the backend asks for rate-in-cents on this endpoint (verify on first real call — see SKILL.md §Currency encoding).
**Depends on:** R21.

---

## Wave 4 — Labels, files, notifications

### R23 — `freelo labels` (project labels)
**Endpoints:** `GET /project-labels/find-available`, `PATCH /project-labels/{labelId}`, `DELETE /project-labels/{labelId}`, `POST /project-labels/add-to-project/{projectId}`, `DELETE /project-labels/remove-from-project/{projectId}`.
**CLI:**
```
freelo labels list [--project <id>]
freelo labels rename <id> --name <str> [--color <hex>]
freelo labels delete <id> [--yes]
freelo labels attach --project <id> --name <str>... [--color <hex>]    # fetch-or-create
freelo labels detach --project <id> --label <id>...
```
**Depends on:** R04, R13.

### R24 — `freelo task-labels`
**Endpoints:** `POST /task-labels` (bulk create), `POST /task-labels/add-to-task/{task_id}`, `DELETE /task-labels/remove-from-task/{task_id}`.
**CLI:**
```
freelo task-labels create --name <str>... [--color <hex>]
freelo task-labels attach --task <id> (--name <str>|--uuid <id>)...
freelo task-labels detach --task <id> (--name <str>|--uuid <id>)...
```
**Depends on:** R10.

### R25 — `freelo files upload`
**Endpoints:** `POST /file/upload` (multipart).
**CLI:** `freelo files upload <path>... [--attach-to-task <id>]`.
**Ships with this slice:** multipart body helper (`undici` `FormData` pattern), progress spinner via `ora`, size/type guards.
**Depends on:** R08.

### R26 — `freelo files list`
**Endpoints:** `GET /all-docs-and-files`.
**CLI:** `freelo files list [--project <id>] [--task <id>] [--type doc|file|link|dir] [--page N|--all]`.
**Depends on:** R25.

### R27 — `freelo files download`
**Endpoints:** `GET /file/{file_uuid}`.
**CLI:** `freelo files download <uuid> [-o <path>] [--stdout]`.
**Depends on:** R26.

### R28 — `freelo notifications`
**Endpoints:** `GET /all-notifications`, `POST /notification/{id}/mark-as-read`, `POST /notification/{id}/mark-as-unread`.
**CLI:**
```
freelo notifications list [--unread] [--page N|--all]
freelo notifications read <id>... [--all-unread]
freelo notifications unread <id>...
```
**Depends on:** R01.

---

## Wave 5 — Project admin

### R29 — `freelo projects create`
**Endpoints:** `POST /projects`.
**CLI:** `freelo projects create --name <str> [--date-start YYYY-MM-DD] [--currency <code>] [--project-owner-id <id>]`.
**Depends on:** R04.

### R30 — `freelo projects archive` / `projects activate` / `projects delete`
**Endpoints:** `POST /project/{id}/archive`, `POST /project/{id}/activate`, `DELETE /project/{id}`.
**CLI:** three small commands, `--yes` for delete.
**Depends on:** R29, R13.

### R31 — `freelo projects create-from-template`
**Endpoints:** `POST /project/create-from-template/{template_id}`.
**CLI:** `freelo projects create-from-template <template_id> --name <str> [--date-start …] [--worker <id>]...`.
**Depends on:** R29.

### R32 — `freelo projects workers`
**Endpoints:** `GET /project/{id}/workers`, `DELETE /project/{id}/remove-workers/by-ids`, `DELETE /project/{id}/remove-workers/by-emails`.
**CLI:**
```
freelo projects workers list --project <id>
freelo projects workers remove --project <id> (--user <id>...|--email <e>...) [--yes]
```
**Depends on:** R04, R13.

### R33 — `freelo projects invite`
**Endpoints:** `POST /users/manage-workers`.
**CLI:** `freelo projects invite --project <id>... (--email <e>|--user <id>)...`.
**Depends on:** R32.

### R34 — `freelo tasklists create` / `delete` / `create-from-template`
**Endpoints:** `POST /project/{id}/tasklists`, `DELETE /tasklist/{id}`, `POST /tasklist/create-from-template/{template_id}`.
**CLI:**
```
freelo tasklists create --project <id> --name <str>
freelo tasklists delete <id> [--yes]
freelo tasklists create-from-template <template_id> --project <id> --name <str>
```
**Depends on:** R06, R13.

---

## Wave 6 — Advanced task surface

### R35 — `freelo tasks remind`
**Endpoints:** `POST /task/{task_id}/reminder`, `DELETE /task/{task_id}/reminder`.
**CLI:** `freelo tasks remind set <id> --at <ISO>` / `freelo tasks remind clear <id>`.
**Depends on:** R10.

### R36 — `freelo tasks share` (public link)
**Endpoints:** `POST /public-link/task/{task_id}`, `DELETE /public-link/task/{task_id}`.
**CLI:** `freelo tasks share <id>` (prints URL) / `freelo tasks unshare <id>`.
**Depends on:** R10.

### R37 — `freelo tasks estimate`
**Endpoints:** `POST /task/{id}/total-time-estimate`, `DELETE /task/{id}/total-time-estimate`, `POST /task/{id}/users-time-estimates/{user_id}`, `DELETE /task/{id}/users-time-estimates/{user_id}`.
**CLI:**
```
freelo tasks estimate set <id> --minutes <n> [--user <id>]        # per-user if --user
freelo tasks estimate clear <id> [--user <id>]
```
**Depends on:** R10.

### R38 — `freelo tasks project add` / `project remove` / `relations`
**Endpoints:** `POST /task/{id}/projects`, `DELETE /task/{id}/projects/{project_id}`, `GET /task/{id}/relations`, `POST /tasks/relations`.
**CLI:**
```
freelo tasks project add <id> --project <id>...
freelo tasks project remove <id> --project <id> [--yes]
freelo tasks relations <id>
freelo tasks find-relations --task <id>...
```
**Depends on:** R10.

### R39 — `freelo tasks create-from-template`
**Endpoints:** `POST /task/create-from-template/{template_id}`.
**CLI:** `freelo tasks create-from-template <template_id> --tasklist <id> [--name <str>]`.
**Depends on:** R09.

---

## Wave 7 — Custom fields, notes, pinned items

### R40 — `freelo custom-fields types` / `list`
**Endpoints:** `GET /custom-field/get-types`, `GET /custom-field/find-by-project/{project_id}`.
**CLI:** `freelo custom-fields types` / `freelo custom-fields list --project <id>`.
**Depends on:** R04.

### R41 — `freelo custom-fields create` / `rename` / `delete` / `restore`
**Endpoints:** `POST /custom-field/create/{project_id}`, `PATCH /custom-field/rename/{uuid}`, `DELETE /custom-field/delete/{uuid}`, `POST /custom-field/restore/{uuid}`.
**CLI:** four small commands.
**Depends on:** R40, R13.

### R42 — `freelo custom-fields value set` / `value clear`
**Endpoints:** `POST /custom-field/add-or-edit-value`, `POST /custom-field/add-or-edit-enum-value`, `DELETE /custom-field/delete-value/{uuid}`.
**CLI:**
```
freelo custom-fields value set --task <id> --field <uuid> (--value <str>|--enum <uuid>)
freelo custom-fields value clear --task <id> --field <uuid>
```
**Depends on:** R40.

### R43 — `freelo custom-fields enum`
**Endpoints:** `GET /custom-field-enum/get-for-custom-field/{uuid}`, `POST /custom-field-enum/create/{uuid}`, `PATCH /custom-field-enum/change/{uuid}`, `DELETE /custom-field-enum/delete/{uuid}`, `DELETE /custom-field-enum/force-delete/{uuid}`.
**CLI:**
```
freelo custom-fields enum list --field <uuid>
freelo custom-fields enum add --field <uuid> --value <str>
freelo custom-fields enum rename <enum_uuid> --value <str>
freelo custom-fields enum delete <enum_uuid> [--force] [--yes]
```
**Depends on:** R41.

### R44 — `freelo notes` + `freelo pins`
**Outcome:** Two related small surfaces, bundled because each is tiny.
**Endpoints:** `GET/POST /project/{id}/note`, `GET/PATCH/DELETE /note/{id}`; `GET /project/{id}/pinned-items`, `POST /project/{id}/pinned-items`, `DELETE /pinned-item/{id}`.
**CLI:**
```
freelo notes list --project <id>        # …create / show / edit / delete
freelo pins list --project <id>         # …add <url> / remove <id>
```
**Depends on:** R04, R13.

---

## Wave 8 — Reporting, audit, reference, search

### R45 — `freelo invoices list` / `show`
**Endpoints:** `GET /issued-invoices`, `GET /issued-invoice/{id}`.
**CLI:** `freelo invoices list [--page N|--all]` / `freelo invoices show <id>`.
**Depends on:** R03.

### R46 — `freelo invoices reports` / `mark-as-invoiced`
**Endpoints:** `GET /issued-invoice/{id}/reports` (CSV), `/reports-json`, `POST /issued-invoice/{id}/mark-as-invoiced`.
**CLI:**
```
freelo invoices reports <id> [--format csv|json] [-o <path>]
freelo invoices mark-invoiced <id> --external-id <str>
```
**Depends on:** R45.

### R47 — `freelo events`
**Endpoints:** `GET /events`.
**CLI:** `freelo events list [--project <id>] [--since DATE] [--page N|--all]`.
**Depends on:** R01.

### R48 — `freelo users`
**Endpoints:** `GET /users`, `GET /users/project-manager-of`, `GET /user/{id}/out-of-office`, `POST /user/{id}/out-of-office`, `DELETE /user/{id}/out-of-office`.
**CLI:**
```
freelo users list
freelo users managed-by-me
freelo users ooo get <user_id>
freelo users ooo set <user_id> --from YYYY-MM-DD --to YYYY-MM-DD [--message <str>]
freelo users ooo clear <user_id>
```
**Depends on:** R01.

### R49 — `freelo states`
**Endpoints:** `GET /states`.
**CLI:** `freelo states list` — exposes state IDs used by `tasks list --state`.
**Depends on:** R07.

### R50 — `freelo search`
**Endpoints:** `GET /search` (Elasticsearch-backed, cross-resource).
**CLI:** `freelo search <query> [--type project|task|comment|file] [--page N|--all]`.
**Depends on:** R07.

---

## Cross-cutting — introduced once, reused by everyone

| Concern | First appears in | Lives at |
|---|---|---|
| HTTP client, Basic Auth, UA header, 429 retry, rate-limit header capture, `AbortSignal` threading | R01 | `src/api/client.ts` |
| Credential precedence (env > keychain > conf), `FREELO_NO_KEYCHAIN`, `--api-key-stdin` | R01 | `src/config/credentials.ts` |
| Non-secret config + `cosmiconfig` + frozen `AppConfig` | R01 / R02 | `src/config/` |
| Global flags (`--output`, `--profile`, `--color`, `-v/-vv`, `--request-id`, `--yes`) | R01 | `src/bin/freelo.ts` |
| TTY / output-mode resolver (`auto` → `human`/`json`) | R01 | `src/lib/env.ts` |
| Envelope builder (`schema`, `data`, `paging`, `rate_limit`, `request_id`) + `json` / `ndjson` / `human` renderers | R01 | `src/ui/envelope.ts`, `src/ui/*.ts` |
| Error taxonomy + `handleTopLevelError` + `freelo.error/v1` envelope + exit codes | R01 | `src/errors/`, `src/bin/freelo.ts` |
| Confirmation + `--yes` + non-TTY `CONFIRMATION_REQUIRED` fail-closed | R01 (policy) / R13 (first use) | `src/lib/confirm.ts` |
| Pino silent-default logger; lazy `pino-pretty` transport | R01 | `src/lib/logger.ts` |
| Lazy-import guard for human-UX deps (ESLint rule + pattern) | R01 | `eslint.config.js`, `src/ui/*` |
| Command-tree introspection (`freelo --introspect`, `freelo help --output json`) | R02.5 | `src/lib/introspect.ts` |
| Pagination normalizer + `--page` / `--all` / `--cursor` | R03 | `src/api/pagination.ts` |
| `--fields` projection on table / JSON output | R03 | `src/ui/project.ts` |
| `--dry-run` shared mixin for write commands | R09 (first write) | `src/lib/dry-run.ts` |
| Batch input: `--id` / `--ids` / `--stdin` NDJSON reader; NDJSON output streamer | R09 | `src/lib/batch.ts`, `src/ui/ndjson.ts` |
| Idempotent-no-op handling (`already_in_target_state: true`) | R11 (first absorbing-state write) | `src/lib/idempotency.ts` |
| Editor / stdin / `--from-file` input | R15 | `src/lib/input.ts` |
| Multipart upload helper | R25 | `src/lib/multipart.ts` |
| Money (cents-as-string) helper | R22 | `src/lib/money.ts` (verify encoding on first use) |
| Codegen-vs-hand-zod decision | R01 | `docs/decisions/` |

## Deliberately deferred

- **VitePress docs site** (only `docs/commands/*.md` pages for now).
- **Telemetry / analytics** (policy: opt-in only; not on the roadmap).
- **Interactive TUI / watch mode.**
- **Webhook ingestion** (the public API doesn't expose webhook CRUD; skip.)
- **Localization** (en only; Freelo itself is CS/SK/EN but we ship en until there's demand).

## How to use this doc

1. Pick the lowest-numbered slice not yet done.
2. Run `/spec R<NN> — <slice title>` to generate the spec.
3. The spec agent should cite the exact endpoint lines in `docs/api/freelo-api.yaml` and the SKILL.md quirks that apply, and include an agent-style invocation (env-var auth + `--output json`) in the Examples section.
4. Every data-returning spec declares an envelope `schema: freelo.<resource>.<op>/v<n>`.
5. Every write spec declares `--dry-run` behavior, idempotency stance, and batch-input support.
6. The plan, implement, test, review, document phases follow as usual (`.claude/docs/sdlc.md`).
7. Ship with a changeset per the `release-workflow` skill. Schema bumps get a dedicated changeset line.

If a slice turns out to be too big during `/spec`, split it and update this roadmap in the same PR.
