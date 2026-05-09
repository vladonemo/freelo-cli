# 0046 — `freelo projects invite` (R33)

**Status:** Accepted — ready for implementation
**Run:** 2026-05-09-r33-projects-invite
**Tier:** Yellow (additive sub-leaf; new envelope schema; minor changeset; no auth / HTTP-default / dep changes)
**Branch:** `feat/projects-invite`
**Cross-reference:** Inherits R09 (`--dry-run`), R32 (spec 0045 — `--user` / `--email` repeatable parsers, dedup, hint-rewrite pattern). Distinct from R32 in that `--user` and `--email` are **NOT** mutex here (one wire body accepts both).

---

## 1. Problem

Wave 5 fifth slice — the last R32-shaped piece of project-admin parity. R32 covered worker **removal** via the two project-scoped DELETE-flavored endpoints. R33 covers **invitation** via the inverse: `POST /users/manage-workers`. After R33 a user can:

- Onboard a batch of new teammates (existing users by id, or external people by email — both in one request) to one or more projects.
- Pre-flight the call with `--dry-run` and see exactly what body would go on the wire.

```
FREELO_API_KEY=*** FREELO_EMAIL=*** \
  freelo projects invite --project 9001 --project 9002 \
    --email new@x.io --user 305 \
    --output json
```

Thin command shell on top of infra already shipped: HTTP client (R01), envelope (R01), error taxonomy (R01), `--dry-run` helper (R09), repeatable-flag dedup (R32 pattern).

## 2. Background — what the API gives us

### 2.1 Endpoint — `POST /users/manage-workers`

OpenAPI :3417-3498 (verified 2026-05-09).

- No path params.
- Request body (required):
  ```json
  {
    "projects_ids": [9001, 9002],
    "emails": ["new@x.io"],
    "users_ids": [305]
  }
  ```
- `projects_ids` is required (yaml :3445). At least one project id must be present, otherwise 400.
- `emails` and `users_ids` are both optional individually but **at least one of them must be non-empty** per yaml :3431. Sending both empty → 400 with the message "At least one of the following fields must be filled: emails, users_ids".
- `emails` and `users_ids` are NOT mutually exclusive on the wire — yaml :3423 explicitly says "by `users_ids`) **and/or** external people (by `emails`)". Both can be combined in one call.
- Emails matching no existing user trigger user creation server-side (yaml :3433); the freshly-created users come back in `newly_created_users`.
- Plan-limit side effects match the email-invite path (yaml :3435); exceeding the seat limit returns `PlanExceededException` (429/403).
- Owner-only: account must have permission to invite to **every** project in `projects_ids`; the call is atomic — partial-project success is not a documented behavior.

### 2.2 Response

- 200 with object body:
  ```jsonc
  {
    "newly_invited_users_to_projects": [...],   // existing users granted access to additional projects
    "newly_created_users":             [...],   // brand-new users provisioned from unknown emails
    "newly_invited_users":             [...],   // overall set — invited (existing or just-created) by email
    "removed_users_from_projects":     [...]    // ACL adjustments that implicitly removed someone
  }
  ```
- All four arrays are object arrays; only `newly_created_users` and `newly_invited_users` are documented at field-level (`{ id, email }` and `{ id, projects_ids, email }` respectively).
- `removed_users_from_projects` is "populated only when some ACL adjustment implicitly removed workers" (yaml :3436) — not used for explicit removal.

### 2.3 Reconciliation with the roadmap line

Roadmap (`docs/roadmap.md` :564-568):

```
freelo projects invite --project <id>... (--email <e> | --user <id>)...
```

Reconciled against the OpenAPI:

- **`--project` is repeatable AND required** (decision 1). Wire field is `projects_ids: integer[]`; one invocation = one bulk POST.
- **`--user` and `--email` are NOT mutex** (decision 2). Roadmap notation `(--email <e> | --user <id>)...` reads like alternation, but the OpenAPI body explicitly allows both in one call. The CLI surface allows both repeatable flags in one invocation — at least one of the two must be non-empty.
- **One invocation = one HTTP request** (decision 3). The endpoint takes arrays; we don't fan out per-project or per-user.
- **No `--acl-tasklist <id>` flag in v1** (decision 4). The OpenAPI body schema does not document a tasklist-scoping field, even though the description (yaml :3434) mentions ACL behavior. Following the R29 / R31 / R32 "don't guess the API; defer undocumented flags" rule. Tracked as R33.5.
- **No destructive confirmation** (decision 5). Invite is additive — workers gain access, no one loses access. The endpoint is not in the destructive verb space (no `confirmDestructive` gate). The `removed_users_from_projects` response field surfaces as informational on the envelope.
- **No `--stdin` / NDJSON batch** (decision 6). The endpoint is itself array-typed across all three input dimensions (projects, users, emails). NDJSON would be ambiguous (one row per project? per user? per (project, user) pair?). Out of scope; revisit if a real workflow demands it.
- **No idempotency mapping** (decision 7). The server is silent on what happens when a user is already on a project — could be no-op, could be 200 with empty buckets, could be 400. Per "don't guess the API", v1 surfaces all server responses as-is. Server's own `newly_invited_users_to_projects` shape implicitly tells the agent which (user, project) pairs were newly granted vs. already-present.

## 3. Proposal

### 3.1 Sub-leaf registration

Single new file `src/commands/projects/invite.ts`. Wired from `src/commands/projects.ts` with one new line `registerInvite(projects, getConfig, env)`. Mirrors `src/commands/projects/create.ts` shape (single leaf, single `meta` export), not the R32 sub-subgroup pattern (R32 has two sibling leaves; R33 has one).

### 3.2 Surface

```
freelo projects invite --project <id>...
                       [--email <addr>...] [--user <id>...]
                       [--dry-run]
                       [--output auto|human|json|ndjson]
```

Shape rules (decision 2):
- `--project <id>` repeatable, **required** (≥ 1).
- `--email <addr>` repeatable, optional individually.
- `--user <id>` repeatable, optional individually.
- At least one of `--email` / `--user` must be non-empty (otherwise `ValidationError` exit 2 with hint mirroring the server message).
- `--dry-run` skips the POST; envelope echoes the body that would go on the wire.

**Per-command `meta`:**

```ts
const inviteMeta: CommandMeta = {
  outputSchema: 'freelo.projects.invite/v1',
  destructive: false,
};
```

### 3.3 Envelope shape — `freelo.projects.invite/v1`

Live success:

```jsonc
{
  "schema": "freelo.projects.invite/v1",
  "data": {
    "projects_ids": [9001, 9002],
    "users_ids":    [305],
    "emails":       ["new@x.io"],
    "result": {
      "newly_invited_users_to_projects": [...],
      "newly_created_users":             [{ "id": 5001, "email": "new@x.io" }],
      "newly_invited_users":             [{ "id": 5001, "projects_ids": [9001, 9002], "email": "new@x.io" }],
      "removed_users_from_projects":     []
    }
  },
  "rate_limit": { "remaining": 40, "reset_at": "..." }
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.invite/v1",
  "dry_run": true,
  "data": {
    "projects_ids": [9001, 9002],
    "users_ids":    [305],
    "emails":       ["new@x.io"],
    "would": {
      "method": "POST",
      "path":   "/users/manage-workers",
      "body":   { "projects_ids": [9001, 9002], "users_ids": [305], "emails": ["new@x.io"] }
    }
  }
}
```

- `data.projects_ids` always present, deduplicated, in input order.
- `data.users_ids` present iff `--user` was supplied (≥ 1 after dedup); else absent.
- `data.emails` present iff `--email` was supplied (≥ 1 after dedup); else absent.
- `data.result` present on **live success only**, mirrors the four wire buckets (passthrough — schema-validated for shape but values are forwarded as `unknown[]` for buckets we don't deeply type).
- `data.would` present on **--dry-run only**. Mutually exclusive with `data.result`.

### 3.4 Confirmation policy

**No confirmation gate** (decision 5). Invite is additive and not in the destructive verb space. `--yes` is still accepted at the global level (it's a root-program flag), but it has no effect on this command — same as `freelo projects create`. The command works in non-TTY without any prompt.

This contrasts with R32 `workers remove`, which uses `confirmDestructive`.

### 3.5 Examples

**Human (TTY):**
```bash
$ freelo projects invite --project 9001 --email new@x.io
Invited 1 person to 1 project.
  - new@x.io  (newly created user, id 5001)
```

**Agent — combined emails + ids on multiple projects:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@example.com \
  freelo projects invite --project 9001 --project 9002 \
    --email new@x.io --user 305 --output json
{"schema":"freelo.projects.invite/v1","data":{"projects_ids":[9001,9002],"users_ids":[305],"emails":["new@x.io"],"result":{...}},"rate_limit":{...}}
```

**Agent — dry-run, ids only:**
```bash
$ freelo projects invite --project 9001 --user 305 --user 150 --dry-run --output json
{"schema":"freelo.projects.invite/v1","dry_run":true,"data":{"projects_ids":[9001],"users_ids":[305,150],"would":{"method":"POST","path":"/users/manage-workers","body":{"projects_ids":[9001],"users_ids":[305,150]}}}}
```

**Error — neither `--user` nor `--email`:**
```bash
$ freelo projects invite --project 9001
freelo: At least one of --email or --user must be supplied.
$ echo $?
2
```

## 4. Errors

Every typed error class triggered by R33 has an exit-code-asserting test (calibration §2).

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Missing `--project` | Commander → required-option | (Commander) | 1 (Commander) | n/a | (Commander default) |
| `--project` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--project is the numeric project id." |
| `--user` not positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--user is a numeric user id; repeat for multiple." |
| `--email` malformed | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--email must be `local@domain`. Repeat for multiple." |
| Neither `--user` nor `--email` | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pass --email <addr> or --user <id> (repeatable)." |
| HTTP 400 (mentions emails / users_ids) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server msg + scan `errors[]` for `emails` / `users_ids` field hint |
| HTTP 401 | `FreeloApiError` (auth) | `AUTH_EXPIRED` | 3 | false | (existing infra) |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false | "Account does not have permission to invite to every project in --project." |
| HTTP 404 | `FreeloApiError` | `NOT_FOUND` | 4 | false | "One or more --project ids not found." |
| HTTP 422 (e.g. plan exceeded variant) | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server msg + plan-limit hint when message references seats / plan |
| HTTP 429 (incl. PlanExceededException) | `RateLimitedError` or `FreeloApiError` | `RATE_LIMITED` / `FREELO_API_ERROR` | 6 / 4 | true / false | server msg; plan-exceeded hint when applicable |
| HTTP 5xx | `FreeloApiError` | `SERVER_ERROR` | 4 | true | (existing) |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |

**400-error hint-rewrite policy** (decision 8): mirrors R29/R32 — Freelo embeds field-level errors in `errors[]`, not in `message`. Hint logic scans both `err.message` and `err.errors[]` joined. When the haystack mentions `emails` or `users_ids`, append a hint pointing at the relevant flag.

## 5. Data model — types

### 5.1 Reused

- `UserBasicSchema` (R01 / R03) — used loosely for the typed sub-fields of `newly_created_users` and `newly_invited_users`.

### 5.2 New (added to `src/api/schemas/project.ts`)

```ts
/* ------------------------------------------------------------------------- *
 *  R33 — `freelo projects invite` (spec 0046)
 *
 *  POST /users/manage-workers (yaml :3417-3498)
 * ------------------------------------------------------------------------- */

/** Wire body shape for POST /users/manage-workers. */
export type ProjectsInviteBody = {
  projects_ids: number[];
  emails?: string[];
  users_ids?: number[];
};

/**
 * Wire response shape for POST /users/manage-workers (yaml :3460-3497).
 * Object arrays are loosely typed because Freelo documents only `id`,
 * `email`, and (on `newly_invited_users`) `projects_ids`. `.passthrough()`
 * tolerates undocumented fields.
 */
export type ProjectsInviteResult = {
  newly_invited_users_to_projects: unknown[];
  newly_created_users: { id?: number; email?: string }[];
  newly_invited_users: { id?: number; email?: string; projects_ids?: number[] }[];
  removed_users_from_projects: unknown[];
};

/**
 * Envelope `data` shape for `freelo.projects.invite/v1`.
 *
 * `projects_ids` is always present (echoed input). `users_ids` and `emails`
 * are present only when the corresponding flag was non-empty after dedup.
 *
 * `result` is present on live success; `would` is present on `--dry-run`.
 * Exactly one of the two is set per envelope.
 */
export type ProjectsInviteData = {
  projects_ids: number[];
  users_ids?: number[];
  emails?: string[];
  result?: ProjectsInviteResult;
  would?: {
    method: 'POST';
    path: '/users/manage-workers';
    body: ProjectsInviteBody;
  };
};
```

### 5.3 Wire wrapper (new file `src/api/projects-invite.ts`)

```ts
const InviteResultSchema = z.object({
  newly_invited_users_to_projects: z.array(z.unknown()).default([]),
  newly_created_users: z.array(z.object({
    id: z.number().int().optional(),
    email: z.string().nullable().optional(),
  }).passthrough()).default([]),
  newly_invited_users: z.array(z.object({
    id: z.number().int().optional(),
    email: z.string().nullable().optional(),
    projects_ids: z.array(z.number().int()).optional(),
  }).passthrough()).default([]),
  removed_users_from_projects: z.array(z.unknown()).default([]),
}).passthrough();

export function projectsInvitePath(): string {
  return '/users/manage-workers';
}

export async function inviteUsersToProjects(
  client: HttpClient,
  body: ProjectsInviteBody,
  opts?: { signal?: AbortSignal; requestId?: string },
): Promise<{ result: ProjectsInviteResult; raw: ApiResponse<ProjectsInviteResult> }>;
```

## 6. Edge cases

- **Single project, single email** → `--project 9001 --email new@x.io`. Body `{ projects_ids: [9001], emails: ["new@x.io"] }`. Smallest valid invocation.
- **Multiple projects, multiple users** → `--project 9001 --project 9002 --user 305 --user 150`. One POST.
- **Combined emails + users in one call** → both `users_ids` and `emails` present in body (decision 2).
- **Duplicate `--project 9001 --project 9001`** → deduplicated, body has `projects_ids: [9001]`.
- **Duplicate `--user`** → deduplicated first-seen-wins (R32 pattern).
- **Duplicate `--email`** → deduplicated as literal strings; case-insensitive matching is NOT done (server is the authority).
- **`--project 0` / `-1` / NaN** → `ValidationError`.
- **`--user 0` / negative / NaN** → `ValidationError`.
- **`--email "not-an-email"`** → `ValidationError` (loose regex `^[^\s@]+@[^\s@]+\.[^\s@]+$`).
- **`--dry-run`** → no POST, no idempotent re-classify, no result bucket. Envelope carries `dry_run: true` and `data.would`.
- **Plan-exceeded (PlanExceededException)** → server may return 429 (rate-limited path) or 403 (auth-style refusal); we surface `FreeloApiError` with the server message. Hint mentions plan/seat limit when the message contains "plan" / "seat" / "limit".
- **Empty arrays after dedup** (impossible via Commander) — N/A; Commander rejects bare `--project` with no value, and our parsers reject zero/negative.
- **Server returns `removed_users_from_projects` populated** → surfaced as-is in `data.result`; informational. CLI does not warn — that would conflict with the additive framing.

## 7. Non-goals (R33 explicit out-of-scope)

- **`--acl-tasklist <id>` for tasklist-scoped invitation** — body field not in the OpenAPI schema (yaml :3438-3459). Tracked as R33.5 if real workflows need it.
- **`--stdin` / NDJSON batch** — endpoint is itself array-typed across three dimensions; NDJSON shape would be ambiguous.
- **Per-project / per-user dry-run preview** — `data.would.body` echoes the bulk wire shape exactly; per-target preview would be a different feature.
- **Re-invitation idempotency mapping** — server's own `newly_invited_users_to_projects` discriminates already-present from newly-granted; agents key off it.
- **Removal** — R32 already covers `workers remove`. R33 is invite-only.

## 8. Open questions

None. Every scope-affecting decision is logged below.

## 9. Decisions log (autonomous)

1. **`--project` is repeatable AND required** — wire field `projects_ids: integer[]` is required per yaml :3445.
2. **`--user` and `--email` are NOT mutex** — yaml :3423 explicitly allows both in one body. The CLI surface allows both repeatable flags in the same invocation; at least one must be non-empty.
3. **One invocation = one HTTP request** — endpoint takes arrays across all three dimensions.
4. **No `--acl-tasklist` flag in v1** — body field not documented in the OpenAPI schema, only mentioned in description prose. Defer per "don't guess the API".
5. **No destructive confirmation** — invite is additive; `confirmDestructive` is not appropriate.
6. **No `--stdin` / NDJSON batch in v1** — array-typed across three dimensions; row shape would be ambiguous.
7. **No idempotency mapping** — server's `newly_invited_users_to_projects` already discriminates re-invites; CLI does not synthesize `already_in_target_state`.
8. **400-error hint logic scans `errors[]` AND `message`** — mirrors R29/R32 (Freelo embeds field-level errors in `errors[]`, not in `message`).
9. **Duplicates are deduplicated first-seen-wins** for all three input dimensions (`--project`, `--user`, `--email`).
10. **Loose email regex client-side** (`^[^\s@]+@[^\s@]+\.[^\s@]+$`) — same as R32 / `auth login` precedent. Server is authority.
11. **`acl_tasklists` (description-only) explicitly out-of-scope** — see decision 4.

(Decisions are written individually to `docs/decisions/2026-05-09-r33-projects-invite-N-...md` for auditability.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/projects-invite.ts`** — wire wrapper + path builder + zod response schema:
   - `projectsInvitePath(): string` → `'/users/manage-workers'`.
   - `inviteUsersToProjects(client, body, opts?): Promise<{ result, raw }>`.
   - Local `InviteResultSchema` (passthrough, all four buckets defaulted to `[]`).

2. **`src/commands/projects/invite.ts`** — single command leaf:
   - `registerInvite(projects, getConfig, env): void`.
   - Per-leaf `meta` export (`inviteMeta`).
   - Helpers: `parsePositiveInt`, `parseProjectIdFlag` (local-only — different label from R32's), `collectProjectId`, `collectUserId`, `collectEmail`.
   - `validateInviteInput(opts): { projectsIds, usersIds, emails }` — dedup + non-empty mutex (at least one of users/emails) + per-element validation.
   - Dry-run path: no HTTP, envelope echoes body.
   - Live path: POST with all-non-empty arrays; rate-limit captured into envelope.
   - 400-error hint rewrite (`rewriteInviteApiHint`).

3. **`src/ui/human/projects-invite.ts`** — single renderer:
   - `renderProjectsInviteHuman(data): string` — single-line summary plus optional bullet list of newly-created users with `(newly created user, id N)` annotation. Dry-run variant uses `(dry-run) Would invite ...`.

4. **`test/api/projects-invite.test.ts`** — vitest, no MSW. Pure tests for path builder.

5. **`test/commands/projects/invite.test.ts`** — vitest + MSW; covers all happy paths, validation, API errors, dry-run, body assertions, introspection.

6. **`.changeset/r33-projects-invite.md`** — `freelo-cli: minor` changeset.

#### Edited files

7. **`src/api/schemas/project.ts`** — append the R33 type block (5.2).

8. **`src/commands/projects.ts`** — register `registerInvite` (one new line + import).

9. **`test/msw/handlers.ts`** — add `projectsInviteHandlers` factory:
   - `ok(result?)` — 200 with the supplied or default result body.
   - `okWhenBody(predicate)` — 200 if body matches predicate, else 500 with diagnostic.
   - `unauthorized()`, `forbidden()`, `notFound()`, `unprocessable(message?)`, `rateLimited()`, `serverError(status?)`, `networkError()`.
   - `badRequest(message)` — 400 with `errors: [message]`.
   - `badRequestWithErrors(errors[])` — 400 with the supplied `errors[]` array (used to test the field-level hint scan).

#### Documentation

10. **`docs/commands/projects-invite.md`** (new) — user docs: scopes, flag table, examples (TTY + agent + dry-run), permission notes (must have invite right on every project; new emails create users; plan-limit caveat).

11. **`README.md`** — autogen Commands block regenerated by `pnpm fix:readme`. **Calibration §3 amendment for this run:** the regen MUST happen AFTER the final `pnpm build`, with no source edits in between. If any `src/commands/**` file is edited after `fix:readme`, rebuild and re-run `check:readme` before commit. Verify by checking `dist/freelo.js` mtime is newer than the latest `src/commands/**` mtime before generating README.

### 11. Test plan

#### `invite` (`test/commands/projects/invite.test.ts`)

Happy paths:
- `--project 9001 --email new@x.io --yes` → JSON envelope, `data.projects_ids: [9001]`, `data.emails: ['new@x.io']`, no `data.users_ids`, `data.result` present, exit 0. Body asserted via MSW: `{ projects_ids: [9001], emails: ['new@x.io'] }` (no `users_ids` key).
- `--project 9001 --project 9002 --user 305` → `data.projects_ids: [9001, 9002]`, `data.users_ids: [305]`, no `data.emails`. Body `{ projects_ids: [9001, 9002], users_ids: [305] }`.
- combined `--project 9001 --user 305 --email new@x.io` → both `users_ids` AND `emails` in body and envelope.
- duplicate `--project 9001 --project 9001` → dedup → body `projects_ids: [9001]`.
- duplicate `--user 305 --user 305` → dedup → `users_ids: [305]`.
- duplicate `--email a@x.io --email a@x.io` → dedup → `emails: ['a@x.io']`.
- human mode renders the success line; with `newly_created_users` present, lists them.
- empty `data.result.newly_*` arrays → human renders "Invited 0 people to 1 project." gracefully (server-side no-op).

Dry-run:
- `--project 9001 --email new@x.io --dry-run` → no HTTP fired, envelope `dry_run: true`, `data.would.path: '/users/manage-workers'`, body matches input. Confirmed via MSW unhandled-request setting + handler reset.
- `--dry-run` does not touch the result bucket; `data.result` is absent.
- human dry-run renders `(dry-run) Would invite 1 person to 1 project (1 by email).`

Validation errors (each → exit 2):
- missing `--project` → Commander required-option (exit 1; Commander's default).
- `--project 0` / `--project abc` / `--project -1`.
- neither `--user` nor `--email`.
- `--user 0` / `--user abc`.
- `--email "not-an-email"`.

API errors (live POST):
- 400 with field-level errors mentioning `emails` → hint references `--email`. Body via `badRequestWithErrors`.
- 400 with field-level errors mentioning `users_ids` → hint references `--user`.
- 400 generic → generic hint.
- 401 → AUTH_EXPIRED exit 3.
- 403 → FORBIDDEN exit 4 with permission hint.
- 404 → NOT_FOUND exit 4 with "one or more --project ids not found" hint.
- 422 (plan-exceeded variant) → exit 4.
- 429 → RATE_LIMITED exit 6.
- 5xx → SERVER_ERROR exit 4.
- network failure → NETWORK_ERROR exit 5.

Introspection:
- `--introspect` lists `projects invite` with `output_schema: 'freelo.projects.invite/v1'` and `destructive: false`.

#### `src/api/projects-invite.ts` (`test/api/projects-invite.test.ts`)

Pure tests:
- `projectsInvitePath()` → `'/users/manage-workers'`.

(Wire-call tests live in the command tests where MSW is set up.)

### 12. Out-of-scope safety net

Confirm via grep before commit:
- No calls to `fetch` outside the shared client.
- No top-level imports of `@inquirer/prompts`, `ora`, `chalk`, `boxen`, `cli-table3`, `pino-pretty` in any new file.
- No new dependencies in `package.json`.
- No new uncovered `try/catch` arms (calibration §4).

### 13. Pre-commit gate sequence (calibration §3 amendment, binding)

```
pnpm build && pnpm typecheck && pnpm lint && pnpm test && pnpm fix:readme && pnpm check:readme
```

`pnpm build` immediately before `fix:readme`/`check:readme`; **no source edits between them**. Verify `dist/freelo.js` mtime is newer than the latest `src/commands/**` mtime before regenerating README.

### 14. Commit plan

Single Conventional Commit:

```
feat(commands): projects invite (R33)

Add `freelo projects invite` mapping to `POST /users/manage-workers`.
Single bulk POST: --project, --user, --email all repeatable; --user and
--email NOT mutex (the wire body accepts both in one call); at least one
of --user / --email must be non-empty.

Reuses the --dry-run helper (R09) and the repeatable-flag dedup pattern
from R32. New envelope schema: freelo.projects.invite/v1.
```

Changeset: `freelo-cli: minor`.
