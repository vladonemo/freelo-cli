# Freelo CLI — Incremental delivery roadmap

> Source of truth: `docs/api/freelo-api.yaml` (108 operations, 17 resource tags).
> This doc slices that surface into requirements a contributor can pick up one at a time. Each requirement is a **vertical slice**: args → authenticated HTTP → zod-validated response → renderer → exit code. No requirement leaves the user with a half-wired subsystem.

## Slicing principles

1. **Every slice ships a command a user can run and get value from.** "Add the HTTP client" is not a slice; "`freelo auth login` works" is. Infrastructure rides in on the first slice that needs it.
2. **Read before write, write before destructive, scalar before bulk.** The happy path is exercised long before the scary ones.
3. **Cross-cutting concerns arrive once and only once.** Flag policy (`--json`, `--profile`, `--yes`), pagination, confirmation prompts, editor/stdin input — each is introduced by one named slice and reused by the rest.
4. **Each wave ends with a coherent product.** After Wave N, a real user can do a real job. We could ship to npm at the end of any wave and it would stand on its own.
5. **Small enough to spec in one `/spec` pass.** A slice should fit in ~1 spec file, ~5–15 files of code, ~20–60 minutes of review.

## Wave overview

| Wave | Theme | Cumulative user value | Slices |
|---|---|---|---|
| 0 | Auth + infra foundation | Log in, verify token, know who you are | R01–R02 |
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

### R01 — `freelo auth login` / `logout` / `whoami`
**Outcome:** User stores credentials per profile and sees their account verified.
**Endpoints:** `GET /users/me` (token verification).
**CLI:**
```
freelo auth login [--email <e>] [--profile <name>]     # prompts for API key interactively
freelo auth logout [--profile <name>]
freelo auth whoami [--profile <name>] [--json]
```
**Ships with this slice (arrives here, reused everywhere):**
- `undici` HTTP client with Basic Auth, `User-Agent: freelo-cli/<version>`, `Accept: application/json`.
- `conf`-backed config + `keytar` secret storage with conf-0600 fallback.
- Global flags: `--profile`, `--json`, `--color <auto|never|always>`, `--verbose`, `-q/--quiet`.
- Error taxonomy: `FreeloApiError`, `ConfigError`, `ValidationError`; exit code map (`0` success, `1` generic, `2` usage, `3` auth, `4` not-found, `5` rate-limited).
- `src/api/client.ts` (fetch + 429 retry w/ jitter for GETs), `src/api/schemas/error.ts`.
- Decision on codegen-vs-hand-zod (see SKILL.md §Codegen) made here and recorded in `docs/decisions/`.
**Depends on:** —

### R02 — `freelo config` surface
**Outcome:** User inspects / switches profiles, sets defaults (output format, default project), without re-running `auth login`.
**Endpoints:** none (local config only).
**CLI:**
```
freelo config list
freelo config get <key>
freelo config set <key> <value>
freelo config unset <key>
freelo config profiles
freelo config use <profile>
```
**Ships with this slice:** `cosmiconfig` loader for project-level `.freelorc.*`; precedence doc (CLI flag > env `FREELO_*` > project rc > user conf > default).
**Depends on:** R01.

---

## Wave 1 — Read-only essentials

Goal after this wave: the CLI is a legitimate read replacement for the Freelo web UI's most-used views.

### R03 — `freelo projects list`
**Outcome:** See your active projects, paginated and filterable.
**Endpoints:** `GET /projects`, `GET /all-projects`, `GET /invited-projects`, `GET /archived-projects`, `GET /template-projects`.
**CLI:**
```
freelo projects list [--scope owned|invited|archived|templates|all] [--page N | --all]
                     [--fields id,name,state,date_start] [--json]
```
**Ships with this slice (infra):**
- `src/api/pagination.ts` — normalizes `{ total, count, page, per_page, data: { <resource>: [] } }` → `{ data, page, perPage, total, nextCursor }`.
- `--page` / `--all` semantics (client-side iteration until `nextCursor === undefined`).
- `src/ui/table.ts` (cli-table3) and `src/ui/json.ts` renderers; `--fields` projection.
- `ProjectListSchema` in `src/api/schemas/project.ts`.
**Depends on:** R01.

### R04 — `freelo projects show <id>`
**Outcome:** See one project's full metadata, workers, and labels.
**Endpoints:** `GET /project/{id}`, `GET /project/{id}/workers`.
**CLI:** `freelo projects show <id> [--with workers,labels] [--json]`
**Depends on:** R03.

### R05 — `freelo tasklists list`
**Outcome:** List tasklists, scoped to a project or across all projects.
**Endpoints:** `GET /project/{project_id}/tasklists`, `GET /all-tasklists`.
**CLI:** `freelo tasklists list [--project <id>] [--page N|--all] [--json]`
**Depends on:** R03.

### R06 — `freelo tasklists show <id>`
**Outcome:** Tasklist detail + assignable workers.
**Endpoints:** `GET /tasklist/{tasklist_id}`, `GET /project/{project_id}/tasklist/{tasklist_id}/assignable-workers`.
**CLI:** `freelo tasklists show <id> [--with assignable-workers] [--json]`
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
                  [--order asc|desc] [--page N|--all] [--fields ...] [--json]
```
**Ships with this slice:**
- `src/lib/query.ts` — encodes array params as `projects_ids[]=...` repeating, not PHP-brackets-in-key.
- Explicit handling of the `with_label` (deprecated, singular) vs `with_labels[]` merge quirk — CLI normalizes to the array form.
**Depends on:** R03.

### R08 — `freelo tasks show <id>`
**Outcome:** Full task view: metadata, description, subtasks, labels.
**Endpoints:** `GET /task/{task_id}`, `GET /task/{task_id}/description`, `GET /task/{task_id}/subtasks`, `GET /task/{task_id}/projects`.
**CLI:** `freelo tasks show <id> [--with description,subtasks,projects] [--json]`
**Depends on:** R07.

---

## Wave 2 — Task lifecycle (daily-driver writes)

Goal after this wave: the CLI is a legitimate write replacement for the most common task workflow.

### R09 — `freelo tasks create`
**Outcome:** Create a task in a tasklist, with workers, label, due date, description.
**Endpoints:** `POST /project/{project_id}/tasklist/{tasklist_id}/tasks`.
**CLI:**
```
freelo tasks create --tasklist <id> --name <str> [--worker <id>]... [--due YYYY-MM-DD]
                    [--priority low|normal|high] [--label <name>]...
                    [--description <text>|--description-file <path>|--editor]
```
**Ships with this slice:**
- POST request schema + body builder pattern.
- Editor/stdin input pattern (`$EDITOR` → tmpfile → read back), reused by R15 and R17.
**Depends on:** R07.

### R10 — `freelo tasks edit <id>`
**Outcome:** Partial update of a task (name, due date, workers, priority, labels).
**Endpoints:** `PATCH /task/{task_id}` (or the spec's edit verb), `POST /task-labels/add-to-task/{task_id}` and `/remove-from-task/{task_id}` for label diff.
**CLI:** same flags as `tasks create` where overlapping, plus `--add-label`, `--remove-label`.
**Depends on:** R09.

### R11 — `freelo tasks finish` / `tasks reopen`
**Outcome:** State transitions from the terminal.
**Endpoints:** `POST /task/{task_id}/finish`, `POST /task/{task_id}/activate`.
**CLI:** `freelo tasks finish <id>` / `freelo tasks reopen <id>`.
**Depends on:** R09.

### R12 — `freelo tasks move <id>`
**Outcome:** Move a task between tasklists, optionally cross-project.
**Endpoints:** `POST /task/{task_id}/move/{tasklist_id}`.
**CLI:** `freelo tasks move <id> --to-tasklist <id> [--to-project <id>]`.
**Depends on:** R10.

### R13 — `freelo tasks delete <id>`
**Outcome:** Soft-delete a task with a safety prompt.
**Endpoints:** `DELETE /task/{task_id}`.
**CLI:** `freelo tasks delete <id> [--yes]`.
**Ships with this slice:**
- `src/lib/confirm.ts` — `--yes` bypass, interactive prompt via `@inquirer/prompts`, **fails closed in non-TTY without `--yes`**.
- Reused by every destructive command in later waves.
**Depends on:** R09.

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
freelo tasks description get <id> [--json]
freelo tasks description set <id> (--from-file <path> | --editor | -)   # `-` = stdin
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
**CLI:** `freelo time start --task <id> [--note <str>]` / `freelo time status [--json]`.
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
**CLI:** `freelo invoices list [--page N|--all]` / `freelo invoices show <id> [--json]`.
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
**CLI:** `freelo states list [--json]` — exposes state IDs used by `tasks list --state`.
**Depends on:** R07.

### R50 — `freelo search`
**Endpoints:** `GET /search` (Elasticsearch-backed, cross-resource).
**CLI:** `freelo search <query> [--type project|task|comment|file] [--page N|--all]`.
**Depends on:** R07.

---

## Cross-cutting — introduced once, reused by everyone

| Concern | First appears in | Lives at |
|---|---|---|
| HTTP client, Basic Auth, UA header, 429 retry | R01 | `src/api/client.ts` |
| Config + keychain + profiles | R01 / R02 | `src/config/` |
| Global flags (`--json`, `--profile`, `--color`, `--verbose`, `-q`) | R01 | `src/bin/freelo.ts` |
| Error taxonomy + top-level formatter + exit codes | R01 | `src/errors/` |
| Pagination normalizer + `--page` / `--all` | R03 | `src/api/pagination.ts` |
| Table + JSON renderers + `--fields` projection | R03 | `src/ui/` |
| Confirmation prompts + `--yes` + non-TTY fail-closed | R13 | `src/lib/confirm.ts` |
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
3. The spec agent should cite the exact endpoint lines in `docs/api/freelo-api.yaml` and the SKILL.md quirks that apply.
4. The plan, implement, test, review, document phases follow as usual (`.claude/docs/sdlc.md`).
5. Ship with a changeset per the `release-workflow` skill.

If a slice turns out to be too big during `/spec`, split it and update this roadmap in the same PR.
