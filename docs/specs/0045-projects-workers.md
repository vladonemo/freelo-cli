# 0045 — `freelo projects workers list` / `projects workers remove` (R32)

**Status:** Accepted — ready for implementation
**Run:** 2026-05-09-1200-r32-projects-workers
**Tier:** Yellow (additive sub-subcommand group with one destructive op; no auth / HTTP-default changes; no new deps)
**Branch:** `feat/projects-workers`
**Cross-reference:** Patterns inherited from spec 0013 (R04 `projects show` — reuses `getProjectWorkers`), spec 0024 (R13 `tasks delete` — destructive flow), spec 0035 (R23 `labels detach` — `--project` filter + repeatable `--<entity>` flag).

---

## 1. Problem

Wave 5 fourth slice. R29-R31 give us project create / archive / activate / delete / create-from-template. The remaining piece for projects-admin parity is membership management:

- Read who is on a project.
- Remove one or more workers from a project.

```
FREELO_API_KEY=*** FREELO_EMAIL=*** \
  freelo projects workers list --project 9001 --output json

FREELO_API_KEY=*** FREELO_EMAIL=*** \
  freelo projects workers remove --project 9001 --user 305 --user 150 --yes
```

Thin command shells on top of infra already shipped: HTTP client (R01), envelope (R01), pagination (R03), `getProjectWorkers` (R04), `confirmDestructive` (R13), `--dry-run` helper (R09), error taxonomy (R01).

## 2. Background — what the API gives us

### 2.1 List endpoint — `GET /project/{project_id}/workers`

OpenAPI :583-619 (verified 2026-05-09).

- Path param: `project_id` (positive integer).
- Query: `?p=N` (page, 0-indexed via shared `PageParam`).
- Response: paginated wrapper with inner key `workers`, items `UserBasic` (id + fullname only — no `hour_rate` here).
- Behavior: returns active workers + owner + guests; not filtered by ACL-tasklist membership; deleted (former) workers do not appear.

**Already wired:** `src/api/projects.ts` exports `getProjectWorkers(client, projectId, { page, signal?, requestId? })` returning a `NormalizedPage<UserBasic>` plus the raw response. R04 uses it as the `--with workers` side-car. R32 list reuses it directly.

### 2.2 Remove-by-ids — `POST /project/{project_id}/remove-workers/by-ids`

OpenAPI :676-716 (verified 2026-05-09).

- Path param: `project_id` (positive integer).
- Request body (required):
  ```json
  { "users_ids": [305, 150, 820] }
  ```
- Response: `SuccessResponse` (`{ result: 'success' }`).
- **Atomicity:** "All given IDs are checked at once by the remove-workers ACL checker — if the caller lacks rights to remove any single user, the whole request fails (no partial removal)" (yaml :689-690).
- **Owner cannot be removed** (yaml :691). Attempting → server 4xx.
- Removing a user also cleans up their task assignments and ACL tasklists in this project (yaml :692).

### 2.3 Remove-by-emails — `POST /project/{project_id}/remove-workers/by-emails`

OpenAPI :718-757 (verified 2026-05-09).

- Path param: `project_id`.
- Request body (required):
  ```json
  { "users_emails": ["user1@freelo.io", "user2@freelo.io"] }
  ```
- Response: `SuccessResponse`.
- "Every email **must** belong to a user currently in the project — otherwise the request fails (pre-check via `IProjectWorkersByEmailChecker`). No partial success" (yaml :731).
- Server resolves emails → ids, then runs the same ACL/owner check as by-ids.

### 2.4 Reconciliation with the roadmap line

Roadmap (`docs/roadmap.md` :552-562):

```
freelo projects workers list --project <id>
freelo projects workers remove --project <id> (--user <id>...|--email <e>...) [--yes]
```

Reconciled against the OpenAPI:

- **Verbs are POST**, not DELETE. Roadmap was wrong; OpenAPI authoritative. Decision 1.
- **`--user` / `--email` are repeatable AND go in one request.** The endpoints take arrays; we don't fan out into N HTTP calls. One invocation = one POST. Decision 2.
- **`--user` and `--email` are mutually exclusive** in one invocation. They map to two different endpoints and the body field set isn't unioned server-side. Decision 3.
- **`--dry-run` added**. R09 makes it mandatory on every write; the spec body just makes it explicit. Decision 4.
- **No batch / `--stdin` / `--ids` flag for `remove`.** The endpoints are themselves array-typed — `--user <id>... --user <id>...` covers the multi-user case in one HTTP call. NDJSON would be confusing here (one row vs. one user vs. one project). Out of scope. Decision 5.
- **No "already_in_target_state" idempotency mapping in v1.** The by-emails endpoint explicitly fails on emails-not-in-project (server pre-check); by-ids isn't documented as idempotent. Per "don't guess the API", v1 surfaces all server errors as `FreeloApiError` — no automatic re-classification. Decision 6.

## 3. Proposal

### 3.1 Sub-subcommand registration

Single new file `src/commands/projects/workers.ts` registers both leaves on a `workers` parent under `projects`:

```ts
export function registerWorkers(projects: Command, getConfig, env): void {
  const workers = projects.command('workers').description('Inspect and manage project membership.');
  registerWorkersList(workers, getConfig, env);
  registerWorkersRemove(workers, getConfig, env);
}
```

`src/commands/projects.ts` adds one line: `registerWorkers(projects, getConfig, env);`. The architecture follows the precedent from `src/commands/projects/transition.ts` — one file owns a tightly-coupled subgroup; leaves still get distinct `meta` and Commander leaves.

### 3.2 `workers list`

```
freelo projects workers list --project <id> [--page N | --all] [--fields <list>]
                              [--output auto|human|json|ndjson]
```

**Per-command `meta`:**

```ts
const listMeta: CommandMeta = {
  outputSchema: 'freelo.projects.workers.list/v1',
  destructive: false,
};
```

**Envelope shape — `freelo.projects.workers.list/v1`:**

```jsonc
{
  "schema": "freelo.projects.workers.list/v1",
  "data": {
    "project_id": 9001,
    "workers": [
      { "id": 305, "fullname": "Jane Doe" },
      { "id": 150, "fullname": "Bob Smith" }
    ]
  },
  "paging": { "page": 0, "per_page": 50, "total": 2, "next_cursor": null },
  "rate_limit": { "remaining": 40, "reset_at": "..." }
}
```

- `data.project_id` is the path-positional input echoed for agent convenience.
- `data.workers` is `UserBasic[]` per the wire schema (`{ id, fullname? }`).
- Pagination semantics mirror R03 / R04: `--page N` returns one page, `--all` (default) iterates until exhausted.

**Default `--page` semantics:** different from `projects list` (which defaults to `--all`). For `workers list` the surface is small (project-scoped, typically tens of users); default to `--all`. Decision 7.

**`--fields`:** projection filter applied to the `workers[*]` rows for human and JSON modes. Allowed fields: `id`, `fullname`. Default: both. (No surprise: the wire shape only has those two.) Decision 8.

### 3.3 `workers remove`

```
freelo projects workers remove --project <id>
  ( --user <id>... | --email <e>... )
  [--yes] [--dry-run]
  [--output auto|human|json|ndjson]
```

**Per-command `meta`:**

```ts
const removeMeta: CommandMeta = {
  outputSchema: 'freelo.projects.workers.remove/v1',
  destructive: true,
};
```

**Envelope shape — `freelo.projects.workers.remove/v1`:**

Live success:

```jsonc
{
  "schema": "freelo.projects.workers.remove/v1",
  "data": {
    "project_id": 9001,
    "removed_by": "ids",        // or "emails"
    "users_ids": [305, 150],    // present iff removed_by === "ids"
    "users_emails": ["..."],    // present iff removed_by === "emails"
    "count": 2
  },
  "rate_limit": { ... }
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.workers.remove/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "removed_by": "ids",
    "users_ids": [305, 150],
    "count": 2,
    "would": {
      "method": "POST",
      "path": "/project/9001/remove-workers/by-ids",
      "body": { "users_ids": [305, 150] }
    }
  }
}
```

- `removed_by` is the discriminant — agents key off it to know which subfield to read.
- `users_ids` and `users_emails` are presented as arrays (echoed from input, deduplicated, in input order). Mutually exclusive on the envelope same as on the CLI.
- `count` is the size of the relevant array (handy for human mode and dashboards).
- One envelope per invocation (no per-user fan-out).

### 3.4 Confirmation policy

Mirrors R13 / R30:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → single prompt for the whole call (N users from one project).
- Non-TTY without `--yes` → throw `ConfirmationError` (exit 2, code `CONFIRMATION_REQUIRED`).

Prompt copy (calibration §7 applies — tests must clear `process.env['CI']`):

```
Remove <count> worker(s) from project #<id>? They lose access immediately and their task assignments in this project are cleared.
```

### 3.5 Examples

**Human (TTY) — list:**
```bash
$ freelo projects workers list --project 9001
ID    FULLNAME
305   Jane Doe
150   Bob Smith
```

**Agent — remove by ids:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects workers remove --project 9001 \
  --user 305 --user 150 --yes --output json
{"schema":"freelo.projects.workers.remove/v1","data":{"project_id":9001,"removed_by":"ids","users_ids":[305,150],"count":2},"rate_limit":{...}}
```

**Agent — remove by emails (dry-run):**
```bash
$ freelo projects workers remove --project 9001 \
  --email a@x.io --email b@y.io --dry-run --output json
{"schema":"freelo.projects.workers.remove/v1","dry_run":true,"data":{"project_id":9001,"removed_by":"emails","users_emails":["a@x.io","b@y.io"],"count":2,"would":{"method":"POST","path":"/project/9001/remove-workers/by-emails","body":{"users_emails":["a@x.io","b@y.io"]}}}}
```

**Error — combining `--user` and `--email`:**
```bash
$ freelo projects workers remove --project 9001 --user 305 --email a@x.io --yes
freelo: --user and --email are mutually exclusive (different endpoints).
$ echo $?
2
```

## 4. Errors

Every typed error class triggered by R32 has an exit-code-asserting test (calibration §2).

### 4.1 `workers list`

| Trigger | Class | code | exitCode | retryable |
|---|---|---|---|---|
| Missing `--project` | Commander → ValidationError | `VALIDATION_ERROR` | 2 | false |
| `--project` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false |
| `--page` not non-negative integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false |
| `--fields` empty / unknown column | `ValidationError` | `VALIDATION_ERROR` | 2 | false |
| HTTP 401 | `FreeloApiError` (auth) | `AUTH_EXPIRED` | 3 | false |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false |
| HTTP 404 | `FreeloApiError` | `NOT_FOUND` | 4 | false |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true |
| HTTP 5xx | `FreeloApiError` | `SERVER_ERROR` | 4 | true |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true |
| Mid-stream pagination failure | underlying class re-thrown | (varies) | (varies) | (varies) |

### 4.2 `workers remove`

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Missing `--project` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--project is the numeric project id." |
| Neither `--user` nor `--email` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pass --user <id> or --email <e>, repeatable." |
| Both `--user` and `--email` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--user and --email are mutually exclusive (different endpoints)." |
| `--user` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--user is a numeric user id; repeat for multiple." |
| `--email` malformed | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--email must be `local@domain`. Repeat for multiple." |
| Non-TTY without `--yes` | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | false | "Pass --yes to bypass the prompt, or run from a TTY." |
| TTY user declines | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | false | "Re-run with --yes to bypass the prompt." |
| HTTP 400 (e.g. owner-removal attempt, bad ids) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message; specialized hint when message mentions owner |
| HTTP 401 | `FreeloApiError` | `AUTH_EXPIRED` | 3 | false | (existing infra hint) |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Account does not have permission to remove workers from this project." |
| HTTP 404 | `FreeloApiError` | `NOT_FOUND` | 4 | false | "Project not found, or your account does not have access." |
| HTTP 422 (e.g. email-not-in-project) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message; specialized hint when about emails |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true | (existing) |
| HTTP 5xx | `FreeloApiError` | `SERVER_ERROR` | 4 | true | (existing) |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |

## 5. Data model — zod schemas + types

### 5.1 Reused

- `UserBasicSchema` (already in `src/api/schemas/project.ts`) — `{ id, fullname?: string|null }`.

### 5.2 New (added to `src/api/schemas/project.ts`)

```ts
/* ------------------------------------------------------------------------- *
 *  R32 — `freelo projects workers list` / `remove` (spec 0045)
 *
 *  GET  /project/{id}/workers                       (already wired in R04)
 *  POST /project/{id}/remove-workers/by-ids         (yaml :676-716)
 *  POST /project/{id}/remove-workers/by-emails      (yaml :718-757)
 * ------------------------------------------------------------------------- */

/**
 * Envelope `data` shape for `freelo.projects.workers.list/v1`. The `workers`
 * array is the merged result of one or more `?p=N` pages — `UserBasic[]`.
 * Spec 0045 §3.2.
 */
export type ProjectsWorkersListData = {
  project_id: number;
  workers: UserBasic[];
};

/** Discriminant for the `remove` envelope (decision 2). */
export type ProjectsWorkersRemovedBy = 'ids' | 'emails';

/**
 * Envelope `data` shape for `freelo.projects.workers.remove/v1`.
 *
 * `removed_by` selects which sibling array is present:
 *   - `'ids'`   ⇒ `users_ids: number[]`, `users_emails` absent
 *   - `'emails'`⇒ `users_emails: string[]`, `users_ids` absent
 *
 * `count` mirrors the size of the chosen array (zero-allocation for agents
 * that key off it). `would` is present only on `--dry-run`.
 *
 * Spec 0045 §3.3.
 */
export type ProjectsWorkersRemoveData = {
  project_id: number;
  removed_by: ProjectsWorkersRemovedBy;
  count: number;
  users_ids?: number[];
  users_emails?: string[];
  /** Present only when `--dry-run`. */
  would?: {
    method: 'POST';
    /** `/project/{id}/remove-workers/by-ids` or `/project/{id}/remove-workers/by-emails`. */
    path: string;
    body:
      | { users_ids: number[] }
      | { users_emails: string[] };
  };
};
```

### 5.3 Wire wrappers (new file `src/api/projects-workers.ts`)

```ts
const SuccessResponseSchema = z.object({ result: z.string().nullable().optional() }).passthrough();

export function projectsWorkersRemoveByIdsPath(projectId: number): string {
  return `/project/${projectId}/remove-workers/by-ids`;
}

export function projectsWorkersRemoveByEmailsPath(projectId: number): string {
  return `/project/${projectId}/remove-workers/by-emails`;
}

export type RemoveByIdsBody = { users_ids: number[] };
export type RemoveByEmailsBody = { users_emails: string[] };

export async function removeProjectWorkersByIds(
  client: HttpClient,
  projectId: number,
  body: RemoveByIdsBody,
  opts?: { signal?: AbortSignal; requestId?: string },
): Promise<{ raw: ApiResponse<unknown> }> { ... }

export async function removeProjectWorkersByEmails(
  client: HttpClient,
  projectId: number,
  body: RemoveByEmailsBody,
  opts?: { signal?: AbortSignal; requestId?: string },
): Promise<{ raw: ApiResponse<unknown> }> { ... }
```

`getProjectWorkers` is reused unchanged from `src/api/projects.ts`.

## 6. Edge cases

### 6.1 `workers list`

- **Empty project** (no workers ever): server returns one page with `data.workers: []`, `total: 0`. Envelope reports `workers: []`, `paging.total: 0`. Human mode prints the empty table with `(no workers)`.
- **Single page, exactly per_page workers:** pagination terminates on the next empty page; merged list is correct.
- **Mid-stream pagination failure on `--all`:** unwrap `PartialPagesError` (mirrors `projects show`'s side-car handler) and surface the inner cause. No partial envelope. Decision 9.
- **`--page N` past end:** Freelo returns an empty page; envelope has `workers: []` and `paging` reflects the empty page.

### 6.2 `workers remove`

- **No `--user` and no `--email` after parse:** `ValidationError` (different from R13's silent zero-id success — here, supplying neither is a clear user error).
- **Empty `--user` collection (impossible via Commander):** N/A; Commander rejects bare `--user` with no value.
- **Duplicate ids in `--user 305 --user 305`:** deduplicated before the wire call. Order preserved (first-seen wins). Decision 10.
- **Duplicate emails:** same — deduplicated, case-insensitive on the local-part **NOT** done; emails are forwarded as-typed (Freelo's matcher decides). Only literal duplicate strings collapse.
- **Email validation:** client-side regex `^[^\s@]+@[^\s@]+\.[^\s@]+$` (loose; matches the existing `auth login` pattern). Server is the authority.
- **`--user 0` / negative / NaN:** `ValidationError`.
- **`--dry-run`:** never confirms, never POSTs. Envelope echoes the body that *would* go on the wire.
- **Owner-removal attempt:** server returns 4xx; we surface `FreeloApiError` with exit 4 + a hint that mentions the owner-cannot-be-removed rule when the message references the owner. Decision 11.
- **`--email` mode on an email not in project:** server pre-check fails the whole request (yaml :731). Surfaces as `FreeloApiError`. No "already not in project" idempotent classification (decision 6).

## 7. Non-goals (R32 explicit out-of-scope)

- **`--stdin` / NDJSON batch:** the endpoints are array-typed; one invocation already handles many users. Out of scope. Decision 5.
- **Inviting workers:** R33 (`projects invite`) covers that. R32 does not surface `POST /users/manage-workers`.
- **Per-user `hour_rate` on list:** the bare `/project/{id}/workers` endpoint doesn't carry rates (yaml :619). Use `freelo projects show <id>` for rates (R04 already exposes them).
- **Filtering `workers list`:** no `--state`, no `--role`, no search. The endpoint takes no query parameters beyond `?p=N`.

## 8. Open questions

None. Every scope-affecting decision is logged below.

## 9. Decisions log (autonomous)

1. **Verbs are POST, not DELETE.** OpenAPI authoritative; roadmap line was wrong.
2. **One invocation = one HTTP request.** `--user` / `--email` are repeatable into one body array per the documented body shape.
3. **`--user` and `--email` are mutually exclusive.** Different endpoints; no merge semantics.
4. **`--dry-run` is mandatory** on `remove`. Inherited from R09; explicit in this spec.
5. **No `--stdin` / NDJSON batch in v1.** The endpoint is itself array-typed; NDJSON would be ambiguous.
6. **No automatic `already_in_target_state` mapping.** API behavior on re-call isn't documented as idempotent. Surface server errors as-is. Revisit if `freelo-api-specialist` later probes a fixture.
7. **`workers list` defaults to `--all`.** Project worker rosters are small; agents typically want the full set.
8. **`--fields` accepts only `id`, `fullname`.** That's the entire wire schema.
9. **Mid-stream pagination failure unwraps `PartialPagesError`.** Mirrors `projects show` decision; single-object envelope, no partial.
10. **Duplicate `--user` / `--email` values are deduplicated (first-seen-wins).** Avoids accidentally double-sending; preserves input order.
11. **400 messages mentioning "owner" get a specialized hint.** "Project owner cannot be removed via this endpoint; transfer ownership first via `--project-owner-id` on a project edit (Wave 6)."

(Decisions are written individually to `docs/decisions/2026-05-09-1200-r32-projects-workers-N-...md` for auditability.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/projects-workers.ts`** — wire wrappers for the two POST endpoints:
   - `projectsWorkersRemoveByIdsPath(projectId): string`
   - `projectsWorkersRemoveByEmailsPath(projectId): string`
   - `removeProjectWorkersByIds(client, projectId, body, opts?): Promise<{ raw }>`
   - `removeProjectWorkersByEmails(client, projectId, body, opts?): Promise<{ raw }>`
   - `SuccessResponseSchema` re-declared locally (mirrors `projects-delete.ts` / `projects-transition.ts`).

2. **`src/commands/projects/workers.ts`** — single file owning the `workers` subgroup:
   - `registerWorkers(projects, getConfig, env)` — creates `workers` parent.
   - `registerWorkersList(workers, getConfig, env)` — leaf for `list`.
   - `registerWorkersRemove(workers, getConfig, env)` — leaf for `remove`.
   - Per-leaf `meta` exports (`listMeta`, `removeMeta`).
   - `parsePositiveInt`, `parseProjectIdFlag`, `collectUserId`, `collectEmail`, `parseFieldsFlag` helpers.
   - `validateRemoveInput(opts)` for mutex + non-empty + per-element validation.
   - List flow: paginated fetch via `getProjectWorkers` + `fetchAllPages` (R03 helper); single page via direct call; envelope build.
   - Remove flow: dedup → confirm → dry-run echo OR live POST (single call) → envelope.

3. **`src/ui/human/projects-workers.ts`** — two renderers:
   - `renderProjectsWorkersListHuman(data, { displayFields? }): Promise<string>` — table (id, fullname).
   - `renderProjectsWorkersRemoveHuman(data): string` — single line: `Removed <count> worker(s) from project #<id>.` or dry-run variant.

4. **`test/api/projects-workers.test.ts`** — vitest, no MSW. Pure tests for path builders.

5. **`test/commands/projects/workers-list.test.ts`** — vitest + MSW.

6. **`test/commands/projects/workers-remove.test.ts`** — vitest + MSW.

7. **`test/fixtures/projects/workers-page0.json`** — sample success page: `{ total: 2, count: 2, page: 0, per_page: 25, data: { workers: [{ id: 305, fullname: "Jane" }, { id: 150, fullname: "Bob" }] } }`.

8. **`.changeset/r32-projects-workers.md`** — minor changeset.

#### Edited files

9. **`src/api/schemas/project.ts`** — append the R32 type block (5.2).

10. **`src/commands/projects.ts`** — register `registerWorkers` (one new line + import).

11. **`test/msw/handlers.ts`** — add `projectsWorkersHandlers` factory:
    - `listOk(projectId, fixture)` — single-page or paged via `?p=N`.
    - `listPaged(projectId, pages)` — multi-page (mirrors `projectShowHandlers.workersPaged`).
    - `listForbidden(projectId, status?)`, `listNotFound(projectId)`, `listServerError(projectId, status?)`, `listRateLimited(projectId)`.
    - `removeByIdsOk(projectId)`, `removeByEmailsOk(projectId)`.
    - `removeByIdsBadRequest(projectId, message)`, `removeByEmailsBadRequest(projectId, message)`.
    - `removeForbidden(projectId, kind)`, `removeNotFound(projectId, kind)`, `removeServerError(projectId, kind, status?)`.
    - `removeAssertBody(projectId, kind, expected)` — variant that asserts the request body shape (used in body-assertion tests).

#### Documentation

12. **`docs/commands/projects-workers.md`** (new) — user docs: scopes, flag table, examples (TTY + agent + dry-run), permission note (owner cannot be removed).

13. **`README.md`** — autogen Commands block regenerated by `pnpm fix:readme`. **Calibration §3 amendment for this run:** the regen MUST happen AFTER the final `pnpm build`, with no source edits in between. If any `src/commands/**` file is edited after `fix:readme`, rebuild and re-run `check:readme` before commit.

### 11. Test plan

#### `workers list` (`test/commands/projects/workers-list.test.ts`)

Happy paths:
- single page `--page 0` → JSON envelope, `data.project_id` set, `data.workers` matches fixture, `paging` set.
- `--all` (default) → merged across two pages, second page empty terminates iteration.
- `--all` with explicit single page (one full page only) → single-page envelope.
- `--fields id` → human-mode table has only ID column; JSON unchanged (decision 8 — `--fields` is a renderer concern).
- human mode renders the workers table with header + rows.
- empty project → `data.workers: []`, human mode renders `(no workers)` row.

Validation errors (each → exit 2):
- missing `--project`.
- `--project 0`, `--project abc`, `--project -1`.
- `--page abc`.
- `--fields ""`, `--fields fullname,unknown`.

API errors:
- 401 → AUTH_EXPIRED exit 3.
- 403 → FORBIDDEN exit 4.
- 404 → NOT_FOUND exit 4.
- 429 → RATE_LIMITED exit 6.
- 500 → SERVER_ERROR exit 4.
- mid-stream `--all` failure → underlying class re-thrown (e.g. 500 on page 1) exit 4.

Introspection:
- `--introspect` lists `projects workers list` with `output_schema` and `destructive: false`.

#### `workers remove` (`test/commands/projects/workers-remove.test.ts`)

Happy paths:
- `--user 305 --user 150 --yes` → JSON envelope, `removed_by: 'ids'`, `users_ids: [305, 150]`, `count: 2`, exit 0. Body asserted via MSW: `{ users_ids: [305, 150] }`.
- `--user 305 --user 305 --user 150 --yes` → dedup → wire body `{ users_ids: [305, 150] }`, envelope `count: 2`.
- `--email a@x.io --email b@y.io --yes` → `removed_by: 'emails'`, `users_emails: [...]`, `count: 2`. Body asserted.
- `--user 305 --yes` (single user) → wire body `{ users_ids: [305] }`, `count: 1`.
- human mode renders the success line.

Dry-run:
- `--user 305 --user 150 --dry-run` → no HTTP, envelope `dry_run: true`, `data.would.path: '/project/9001/remove-workers/by-ids'`, body matches input.
- `--email a@x.io --dry-run` → `would.path: '/project/9001/remove-workers/by-emails'`, body `{ users_emails: ['a@x.io'] }`.
- `--dry-run` skips the confirmation prompt (no destructive effect, no prompt).
- human dry-run renders `(dry-run) Would remove 2 worker(s) from project #9001 (by ids).`

Confirmation gate:
- non-TTY without `--yes` → `ConfirmationError` exit 2, no HTTP fired.
- TTY without `--yes` and user accepts → POST fires (calibration §7 — clear `CI`).
- TTY without `--yes` and user declines → exit 2, no HTTP.
- prompt copy mentions "Remove", project id, and immediate-loss-of-access wording (calibration §7).

Validation errors (each → exit 2):
- missing `--project`.
- `--project 0`, `--project abc`.
- neither `--user` nor `--email`.
- both `--user` and `--email` (mutex).
- `--user 0`, `--user abc`.
- `--email "not-an-email"`.

API errors:
- 400 with "owner" mention → owner-flavored hint, exit 4.
- 400 generic → generic, exit 4.
- 401 → AUTH_EXPIRED exit 3.
- 403 → FORBIDDEN exit 4 with permission hint.
- 404 → NOT_FOUND exit 4 with project-not-found hint.
- 422 (e.g. email-not-in-project) → exit 4.
- 429 → RATE_LIMITED exit 6.
- 5xx → SERVER_ERROR exit 4.
- network → NETWORK_ERROR exit 5.

Introspection:
- `--introspect` lists `projects workers remove` with `output_schema` and `destructive: true`.

#### `src/api/projects-workers.ts` (`test/api/projects-workers.test.ts`)

Pure tests:
- `projectsWorkersRemoveByIdsPath(9001)` → `/project/9001/remove-workers/by-ids`.
- `projectsWorkersRemoveByEmailsPath(9001)` → `/project/9001/remove-workers/by-emails`.

(The wire-call tests live in the command tests where MSW is set up.)

### 12. Out-of-scope safety net

Confirm via grep before commit:
- No calls to `fetch` outside the shared client.
- No top-level imports of `@inquirer/prompts`, `ora`, `chalk`, `boxen`, `cli-table3` in any new file.
- No new dependencies in `package.json`.
- No new `try/catch` arms uncovered by tests (calibration §4).

### 13. Commit plan

Single Conventional Commit:

```
feat(commands): projects workers list / remove (R32)

Add `freelo projects workers list` and `freelo projects workers remove`,
mapping respectively to `GET /project/{id}/workers` (paginated) and
`POST /project/{id}/remove-workers/by-{ids,emails}` (atomic, array-bodied).

`remove` reuses confirmDestructive (R13) and the --dry-run helper (R09);
`list` reuses fetchAllPages (R03). One invocation = one POST per the
documented array body — no per-user fan-out.

New envelope schemas: freelo.projects.workers.list/v1,
freelo.projects.workers.remove/v1.
```

Changeset: minor.
