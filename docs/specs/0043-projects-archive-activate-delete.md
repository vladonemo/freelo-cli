# 0043 — `freelo projects archive` / `projects activate` / `projects delete` (R30)

**Status:** Accepted — ready for implementation
**Run:** 2026-05-09-0917-r30-projects-archive-activate-delete
**Tier:** Yellow (three additive commands + three new envelope schemas; no auth/HTTP-default changes; no new deps)
**Branch:** `feat/projects-archive-activate-delete`
**Cross-reference:** Patterns inherited from spec 0021 (R11 `tasks finish` / `reopen` — first absorbing-state writes; the verb-shared-module pattern) and spec 0024 (R13 `tasks delete` — first destructive write; the confirm pattern). API endpoints are documented in `docs/api/freelo-api.yaml` lines 557-581 (delete), 621-647 (archive), 649-674 (activate).

---

## 1. Problem

R29 shipped `freelo projects create` — Wave 5 can now create projects from the terminal. But the project lifecycle has three more states the CLI cannot reach: archived (frozen, hidden from default lists), active (the post-archive / post-delete restore), and deleted (soft-removed). Web-UI round-tripping is still required for archival and clean-up.

R30 closes those gaps with three small commands. After R30:

```bash
# Archive a finished engagement.
freelo projects archive 9001 --yes

# Restore an archived project (or undelete one).
freelo projects activate 9001

# Soft-delete a test / mistake project.
freelo projects delete 9002 --yes
```

`archive` and `activate` are absorbing-state writes — calling them on a project already in the target state is a success (no-op). `delete` is destructive — it reuses the R13 confirm helper unchanged.

This is the second slice of Wave 5. It uses every piece of shared write infra introduced in Waves 2-4: `src/lib/dry-run.ts` (R09), `src/lib/batch.ts` (R09), `src/lib/idempotency.ts` (R11), `src/lib/confirm.ts` (R13).

## 2. Background — what the API gives us

All three endpoints take **no body** and return `SuccessResponse` (`{ result: 'success' }`). All three are documented in `docs/api/freelo-api.yaml` (verified 2026-05-09).

### 2.1 `POST /project/{project_id}/archive` (yaml :621-647)

**operationId:** `archiveProject`

> "No request body is expected. Archiving is idempotent: calling it on an already archived project succeeds (200) without side effects."

Side effect: state transitions to `archived` (state_id=2). Running timetrackings are NOT auto-stopped server-side. Permission: project-admin (owner / commander).

### 2.2 `POST /project/{project_id}/activate` (yaml :649-674)

**operationId:** `activateProject`

> "Restores a project into the **active** state. Works as a single entry point for both 'unarchive' and 'undelete'. The endpoint inspects the project's current state and performs the appropriate transition: if archived → unarchive; if deleted → undelete; otherwise no-op returning 200."

> "Can fail with `PlanExceededException` — restoring a project counts against the caller's plan limits and may be refused if the plan is already at its project cap."

Server-side idempotency is built in. Plan-cap rejection surfaces as 4xx (likely 422 with `PlanExceededException` in the body). Permission: project-admin.

### 2.3 `DELETE /project/{id}` (yaml :557-581)

**operationId:** `deleteProject`

> "Marks the project as deleted. The project disappears from all listings, but is retained in the database. This is a **soft-delete** — the project row stays, but `deletedAt` is set. `POST /project/{id}/activate` restores it."

Side effects: cascades to tasklists/tasks; running timetrackings may stop server-side; webhooks fire. Permission: project-admin (usually owner / commander).

### 2.4 Reconciliation with the roadmap line

Roadmap entry (R30):
```
freelo projects archive / projects activate / projects delete
Endpoints: POST /project/{id}/archive, POST /project/{id}/activate, DELETE /project/{id}
CLI: three small commands, --yes for delete.
```

Reconciled against the OpenAPI:

- **Three commands ship** in this slice, in one PR. They share heavy infra (verb-shared transition module + destructive module + two thin wire wrappers).
- **`archive` and `activate` are NOT destructive** — `--yes` is irrelevant; they are absorbing-state writes mirroring `tasks finish` / `tasks reopen` (R11). They support `<id>...` / `--ids` / `--stdin` / `--dry-run`.
- **`delete` IS destructive** — `--yes` (or TTY confirm) required. Mirrors `tasks delete` (R13). Supports `<id>...` / `--ids` / `--stdin` / `--dry-run`.
- **No GET pre-check on the wire path.** R11's `tasks finish` did a GET pre-check to short-circuit the POST when the task was already in the target state. R30 skips that pre-check for three reasons (decision 1):
  1. The Freelo API documents server-side idempotency for both `archive` (yaml :635) and `activate` (yaml :662). A redundant client GET buys us nothing on the wire.
  2. `GET /project/{id}` on a deleted project can 404 (deleted projects "disappear from all listings" per yaml :562); that would force `activate` (which IS supposed to undelete) to special-case the 404. Trading one round-trip for a brittle special-case is a bad tradeoff.
  3. Without a pre-check, we cannot populate `previous_state` in the success envelope — we accept that and emit `previous_state: null` (decision 2). Agents that want the previous state can call `freelo projects show` first.

## 3. Proposal

### 3.1 Subcommand signatures

#### `freelo projects archive`

```
freelo projects archive <id>...
  [--ids "a,b,c"]                  # mutex with positional and --stdin
  [--stdin]                        # NDJSON: one {"id": <int>} per line
  [--dry-run]                      # skip the POST; envelope echoes `would`
```

No `--yes`. Archive is reversible (via `activate`). Treated as non-destructive.

#### `freelo projects activate`

```
freelo projects activate <id>...
  [--ids "a,b,c"]
  [--stdin]
  [--dry-run]
```

Same shape as `archive`. No `--yes`. Activate-of-already-active is a 200 no-op (decision 1.1).

#### `freelo projects delete`

```
freelo projects delete <id>...
  [--ids "a,b,c"]
  [--stdin]
  [--dry-run]
  [--yes]                          # global flag inherited from root program
```

Destructive. Same prompt-once-for-the-run / fail-closed semantics as `tasks delete` (R13).

#### Per-command `meta`

```ts
// archive
{ outputSchema: 'freelo.projects.archive/v1', destructive: false }

// activate
{ outputSchema: 'freelo.projects.activate/v1', destructive: false }

// delete
{ outputSchema: 'freelo.projects.delete/v1', destructive: true }
```

### 3.2 Envelope shapes

#### `freelo.projects.archive/v1`

Live success (POST returned 200):

```jsonc
{
  "schema": "freelo.projects.archive/v1",
  "data": {
    "project_id": 9001,
    "current_state": "archived"
  },
  "rate_limit": { "remaining": 41, "reset_at": "2026-05-09T20:30:00Z" },
  "request_id": "..."
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.archive/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "current_state": "archived",
    "would": { "method": "POST", "path": "/project/9001/archive", "body": {} }
  }
}
```

NDJSON / multi-id mode adds `line_index` (stdin) per item. Same shape, repeated.

#### `freelo.projects.activate/v1`

Identical to archive's, with `current_state: "active"` and path `/project/{id}/activate`. Schema discriminant is `freelo.projects.activate/v1`.

#### `freelo.projects.delete/v1`

Live success:

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": false
  },
  "rate_limit": { ... },
  "request_id": "..."
}
```

404-from-DELETE (idempotent already-deleted, mirrors R13 decision 3):

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": true
  }
}
```

`--dry-run`:

```jsonc
{
  "schema": "freelo.projects.delete/v1",
  "dry_run": true,
  "data": {
    "project_id": 9001,
    "current_state": "deleted",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/project/9001", "body": {} }
  }
}
```

### 3.3 Idempotency model

| Command | Server-side idempotent? | Client behavior |
|---|---|---|
| `archive` | Yes (yaml :635 — re-archive is 200 no-op) | POST always; trust 200; `already_in_target_state` is **not** emitted in the envelope (no way to distinguish from a fresh archive without a GET pre-check, which decision 1 rejects). Decision 3. |
| `activate` | Yes (yaml :662 — undelete + unarchive + already-active all 200) | POST always; trust 200; same — no `already_in_target_state` field. Decision 3. |
| `delete` | No on the wire; the CLI re-classifies a 404 as idempotent | DELETE; on success → 200; on `FreeloApiError` with code `NOT_FOUND` → emit success envelope with `already_in_target_state: true`. Mirrors R13 (decision 3 of spec 0024). Decision 4. |

The `already_in_target_state` field is **only** present on the `delete` schema. The two transition schemas omit it — agents read `current_state` directly. Schema-level honesty: we don't lie about what we know.

This is a deliberate divergence from R11's transition model. R11 has a GET pre-check, so `previous_state` AND `already_in_target_state` are observable. R30 doesn't, so neither is. Decision 5.

### 3.4 Confirmation policy (`projects delete` only)

Reuses `confirmDestructive` from `src/lib/confirm.ts` byte-for-byte:

- `--yes` → unconditional proceed.
- `--dry-run` → unconditional proceed (no destructive effect).
- TTY without `--yes` → prompt once for the whole run with copy: `"Delete N project(s)? This is a soft-delete; restore via 'freelo projects activate'."`. Decision 6.
- Non-TTY without `--yes` → throw `ConfirmationError` (`code: CONFIRMATION_REQUIRED`, `exitCode: 2`).

The "soft-delete; restore via activate" hint in the prompt copy is meaningful: project deletion is reversible, so the prompt's friction need not match a "permanently destroy" tone. Same calibration §7 caveat — tests of the TTY-prompt path MUST clear `process.env['CI']`.

### 3.5 Field naming and rules

- Snake-case on the wire (`SuccessResponse`'s `result`); we don't surface the wire body in any envelope.
- `data.project_id` (snake-case) — public envelope contract; agents key off this.
- `data.current_state` — string literal (`'archived'` / `'active'` / `'deleted'`). Useful for chained automations: "archive then assert current_state".
- Top-level keys agents may key off: `schema`, `data.project_id`, `data.current_state`, `dry_run`. Plus `data.already_in_target_state` on `delete`.

### 3.6 Example invocations

**Archive a single project (TTY, JSON):**
```bash
$ freelo projects archive 9001 --output json
{"schema":"freelo.projects.archive/v1","data":{"project_id":9001,"current_state":"archived"},"rate_limit":{...}}
```

**Activate (un-archive) — agent style:**
```bash
$ FREELO_API_KEY=*** FREELO_EMAIL=bot@x \
  freelo projects activate 9001 --output json
{"schema":"freelo.projects.activate/v1","data":{"project_id":9001,"current_state":"active"},"rate_limit":{...}}
```

**Batch archive via NDJSON:**
```bash
$ printf '{"id":9001}\n{"id":9002}\n{"id":9003}\n' | \
  freelo projects archive --stdin --output json
{"schema":"freelo.projects.archive/v1","data":{"project_id":9001,"current_state":"archived","line_index":0},...}
{"schema":"freelo.projects.archive/v1","data":{"project_id":9002,"current_state":"archived","line_index":1},...}
{"schema":"freelo.projects.archive/v1","data":{"project_id":9003,"current_state":"archived","line_index":2},...}
```

**Delete with confirmation bypass:**
```bash
$ freelo projects delete 9001 --yes --output json
{"schema":"freelo.projects.delete/v1","data":{"project_id":9001,"current_state":"deleted","already_in_target_state":false},...}
```

**Delete dry-run:**
```bash
$ freelo projects delete 9001 --dry-run --output json
{"schema":"freelo.projects.delete/v1","dry_run":true,"data":{"project_id":9001,"current_state":"deleted","already_in_target_state":false,"would":{"method":"DELETE","path":"/project/9001","body":{}}}}
```

**Delete in non-TTY without --yes (CI / pipe):**
```bash
$ echo "" | freelo projects delete 9001 --output json
# stderr:
# {"schema":"freelo.error/v1","error":{"code":"CONFIRMATION_REQUIRED",...}}
$ echo $?
2
```

## 4. Errors

Every typed error class triggered by R30 has an exit-code-asserting test (calibration §2). Three commands, identical error matrix per command (different code paths but same triggers):

| Trigger | Class | code | exitCode | retryable | hint_next |
|---|---|---|---|---|---|
| Bad `<id>` (non-integer) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "<id> must be a positive integer." |
| Bad `<id>` (zero/negative) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | (same) |
| `--ids "a,bad,c"` (mid-list bad token) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--ids must be a positive integer." |
| `--ids ""` (empty after split) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "--ids requires at least one id." |
| Combining input sources (positional + --ids, etc.) | `ValidationError` | `VALIDATION_ERROR` | 2 | false | "Pick exactly one input source." |
| No ids at all | `ValidationError` (single mode) / silent success exit 0 (matches R09 for batch) | `VALIDATION_ERROR` for `<id>` missing in single, **silent exit 0** for empty `--stdin` / `--ids` (consistent with R09/R11/R13). | 2 / 0 | false | "Pass numeric ids…" |
| `delete` non-TTY without `--yes` | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | false | "Pass --yes to bypass the prompt, or run from a TTY." |
| `delete` TTY user declines | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | false | "Re-run with --yes to bypass the prompt." |
| HTTP 401 | `FreeloApiError` (mapped by client) | `AUTH_EXPIRED` | 3 | false | "Re-authenticate with `freelo auth login`." |
| HTTP 403 | `FreeloApiError` | `FORBIDDEN` | 4 | false | (server message; no command-specific override in v1) |
| HTTP 404 (archive / activate path) | `FreeloApiError` | `NOT_FOUND` | 4 | false | "Project does not exist or you cannot access it." |
| HTTP 404 (DELETE path) | re-classified as **success** with `already_in_target_state: true` (decision 4) | n/a | 0 | n/a | n/a |
| HTTP 422 | `FreeloApiError` | `FREELO_API_ERROR` | 4 | false | server message passed through (e.g. `PlanExceededException` on activate) |
| HTTP 429 | `RateLimitedError` | `RATE_LIMITED` | 6 | true | "Retry after `retry_after` seconds." |
| HTTP 5xx | `FreeloApiError` | `FREELO_API_ERROR` | 4 | true | "Retry; if it persists, check Freelo status." |
| Network failure | `NetworkError` | `NETWORK_ERROR` | 5 | true | (existing) |
| NDJSON line not valid JSON / fails schema | `ValidationError` (per-line) | `VALIDATION_ERROR` | 2 | false | "Each line must be a complete JSON object…" |

In multi-id / stdin batch mode: per-id failures emit a `freelo.error/v1` envelope to stdout (the success stream — matches R11/R13 batch contract) with `context.line_index` (stdin) or `context.input_index` (positional / --ids), and the run exit code is the **highest** of all observed exit codes.

## 5. Data model — zod schemas + types

Add to `src/api/schemas/project.ts` (one section, three schemas/types):

```ts
/* ------------------------------------------------------------------------- *
 *  R30 — `freelo projects archive` / `activate` / `delete` (spec 0043)
 *
 *  All three endpoints return `SuccessResponse` ({ result: 'success' }) with
 *  no body content the CLI surfaces. The envelope `data` shape is built from
 *  the verb (target state) plus the project_id the caller passed, NOT from
 *  the wire response.
 * ------------------------------------------------------------------------- */

export type ProjectsTransitionVerb = 'archive' | 'activate';

/** Target state per verb. Public envelope contract. */
export type ProjectsTargetState = 'archived' | 'active' | 'deleted';

/**
 * Envelope `data` shape for `freelo.projects.archive/v1` and
 * `freelo.projects.activate/v1` — identical, distinguished only by the
 * envelope's `schema` discriminant.
 *
 * No `previous_state` / `already_in_target_state` (decision 5): we don't
 * pre-fetch state, so we can't honestly populate either.
 */
export type ProjectsTransitionData = {
  project_id: number;
  current_state: 'archived' | 'active';
  line_index?: number; // present only when invoked via --stdin
  would?: {
    method: 'POST';
    path: string; // /project/{id}/archive | /project/{id}/activate
    body: Record<string, never>;
  };
};

/**
 * Envelope `data` shape for `freelo.projects.delete/v1`. Carries
 * `already_in_target_state` because the DELETE path observes 404 → idempotent
 * re-delete (decision 4 / mirrors R13).
 */
export type ProjectsDeleteData = {
  project_id: number;
  current_state: 'deleted';
  already_in_target_state: boolean;
  line_index?: number;
  would?: {
    method: 'DELETE';
    path: string; // /project/{id}
    body: Record<string, never>;
  };
};
```

No new zod schema for the wire response — both endpoints use the existing `SuccessResponseSchema` already defined inline in `src/api/tasks-transition.ts` and `src/api/tasks-delete.ts`. The two new wire-wrapper files (`src/api/projects-transition.ts`, `src/api/projects-delete.ts`) will define their own local `SuccessResponseSchema` (matching the per-file convention).

## 6. Edge cases

- **`activate` of an already-active project**: server returns 200 (yaml :662 "otherwise no-op returning 200"). We surface a normal success envelope with `current_state: 'active'`. Agents calling `activate` blindly to ensure-active get clean idempotency.
- **`archive` of an already-archived project**: server returns 200 (yaml :635 "is idempotent"). Same — normal success envelope, `current_state: 'archived'`.
- **`activate` of a deleted project**: server undeletes AND returns 200. Envelope reports `current_state: 'active'`. Decision 7.
- **`activate` hits plan cap**: server returns `PlanExceededException` (likely 422). Surfaces as `FreeloApiError`. The server message is passed through; we don't add a CLI-side hint in v1 (decision 8). Future R30.5 could add: "Plan limit reached; archive a different project first."
- **`archive` of a deleted project**: undocumented. Server may return 200 (no-op) or 404 (project not addressable). We don't special-case; whatever the server returns, the client surfaces. Decision 9.
- **`delete` of an already-deleted project**: server returns 404. Re-classified as success-with-`already_in_target_state: true` (decision 4 / mirrors R13).
- **`delete` while project has a running timetracking**: server may stop the timetracking server-side (per yaml :570). The CLI does NOT pre-check or pre-stop. Decision 10.
- **Bad `<id>` token in any input source**: rejected as `ValidationError` (exit 2) at parse time. Bad token mid-`--ids` list aborts the whole run before any wire call.
- **`<id>` collides with a Commander reserved keyword (e.g. `--`)**: positional collector sees the literal token; Commander handles option parsing first.
- **Empty `--stdin`**: silent success exit 0 (matches R09/R11/R13).
- **Multi-id with all 404s** (`delete` only): all per-id results emit `already_in_target_state: true` envelopes — final exit 0 (the run never observed an error).
- **Mixed-result multi-id** (`delete`: one 200, one 404, one 403): two success envelopes emitted to stdout, one error envelope to stdout (per-line shape), final exit 4.
- **`delete --dry-run`** in TTY: confirmation gate is skipped (decision: dry-run never prompts). Same as R13.

## 7. Non-goals (R30 explicit out-of-scope)

- GET pre-check on the wire path (decision 1) — agents use `freelo projects show` if they need observed state first.
- `previous_state` / `already_in_target_state` field on archive / activate envelopes (decision 5) — not honest without a pre-check.
- `--restore` flag on `delete` (i.e. immediate undelete) — restore is a separate command (`activate`); no compound op.
- Hard-delete of a project — Freelo doesn't expose one; soft-delete is the only flavor.
- Cascading archive of all tasks in a project — not exposed as a separate endpoint; archiving a project doesn't auto-finish tasks server-side.
- Pre-stop-timetracking-on-delete — decision 10.
- `projects archive --keep-running-trackers` — not a Freelo flag; out of scope.

## 8. Open questions

None. Every scope-affecting question is resolved as a logged decision (decisions 1-10).

## 9. Decisions log (autonomous)

1. **No GET pre-check on the wire path.** Server-side idempotency makes it redundant; pre-check on a deleted project would 404; trade-off is `previous_state` is unobservable. Reasoning is in §2.4.
2. **`previous_state` not surfaced** in archive/activate envelopes — without a pre-check, we'd be lying. Agents that need it call `freelo projects show` first.
3. **Server-side idempotency trusted** for archive/activate — the OpenAPI explicitly documents both as 200-no-op-on-already-in-target-state. We POST always.
4. **404-on-DELETE → idempotent already-deleted** — mirrors R13 (spec 0024 decision 3). The only asymmetry between `tasks delete` and `projects delete` is the resource name.
5. **`already_in_target_state` lives on `delete` schema only**, not archive/activate. Decision 1 makes pre-check unobservable for the transition verbs; better to omit than to lie.
6. **Confirm prompt mentions the soft-delete reversibility** — copy: `"Delete N project(s)? This is a soft-delete; restore via 'freelo projects activate'."`. Friction is calibrated to the actual destructive blast radius.
7. **`activate` of a deleted project surfaces as `current_state: 'active'`** — matches the API's documented "single entry point for both unarchive and undelete" behavior. The user-visible result IS active.
8. **No CLI-side hint for `PlanExceededException`** in v1 — server message passed through. Tracked as future R30.5.
9. **No special-case for `archive` of a deleted project** — undocumented behavior; whatever server returns, surface. If real-world tests find a sharp edge, fix forward.
10. **No pre-stop of running timetrackings on delete** — server handles it (yaml :570). The CLI being thinner than the API server is a feature, not a bug.

(Decisions are written individually to `docs/decisions/2026-05-09-0917-r30-N-...md` files for auditability.)

---

## Plan

> **Plan rule:** the plan is the contract. If implementation deviates, update the plan first.

### 10. File-level TODOs

#### New files

1. **`src/api/projects-transition.ts`** — wire wrapper for `archive` + `activate`. Mirrors `src/api/tasks-transition.ts`:
   - `export type ProjectsTransitionVerb = 'archive' | 'activate';`
   - `export function projectsTransitionPath(verb, projectId): string` (returns `/project/{id}/archive` or `/project/{id}/activate`).
   - `export async function archiveProject(client, projectId, opts): Promise<TransitionResult>`
   - `export async function activateProject(client, projectId, opts): Promise<TransitionResult>`
   - Local `SuccessResponseSchema` (mirrors tasks-transition.ts).

2. **`src/api/projects-delete.ts`** — wire wrapper for `DELETE /project/{id}`. Mirrors `src/api/tasks-delete.ts`:
   - `export function projectDeletePath(projectId): string`
   - `export async function deleteProject(client, projectId, opts): Promise<DeleteResult>`
   - Local `SuccessResponseSchema`.

3. **`src/commands/projects/transition.ts`** — shared command logic for `archive` + `activate`. Mirrors `src/commands/tasks/transition.ts`. Owns:
   - `registerArchive(projects, getConfig, env)` and `registerActivate(...)` exports.
   - Internal `VerbWiring` table (verb name → schema discriminant → target state → command description).
   - Variadic `<id>...` collector, `--ids` parser, `--stdin` NDJSON loop, `--dry-run` envelope build, single-mode vs. batch error semantics.
   - **No GET pre-check** (decision 1): different from R11. The flow is: validate → POST → emit envelope.
   - **No idempotency helper call** (decision 5): no `previous_state` / `already_in_target_state`.

4. **`src/commands/projects/archive.ts`** — Commander leaf, one-liner:
   ```ts
   export { registerArchive } from './transition.js';
   ```
   Pattern matches `tasks/finish.ts`. Allows `src/commands/projects.ts` to import `registerArchive` symmetrically with the other leaves.

5. **`src/commands/projects/activate.ts`** — same as #4, exports `registerActivate`.

6. **`src/commands/projects/delete.ts`** — destructive command. Mirrors `src/commands/tasks/delete.ts`:
   - `registerDelete(projects, getConfig, env)` export.
   - Variadic `<id>...` + `--ids` + `--stdin` + `--dry-run`. Walks command tree to read global `--yes` (`resolveYesFlag`).
   - One-shot confirm via `confirmDestructive`. Custom `confirmMessage(count)` with the soft-delete copy from decision 6.
   - Per-id flow: dry-run path → live DELETE path → 404 → emit `already_in_target_state: true`.
   - Multi-id / stdin error semantics match R13 byte-for-byte (per-line errors, exit code = max).

7. **`src/ui/human/projects-transition.ts`** — single-line human renderer for archive / activate:
   - `Archived project #9001.`
   - `Activated project #9001.`
   - Dry-run prefix: `(dry-run) Would archive project #9001.` / `(dry-run) Would activate project #9001.`

8. **`src/ui/human/projects-delete.ts`** — single-line human renderer for delete:
   - `Deleted project #9001.`
   - `Project #9001 was already deleted.`  (when `already_in_target_state: true`)
   - Dry-run: `(dry-run) Would delete project #9001.`

9. **`test/commands/projects/archive.test.ts`** — vitest + MSW. Per-row tests:
   - happy: single positional id → JSON envelope, schema, exit 0
   - happy: positional batch (3 ids) → 3 envelopes
   - happy: `--ids "1,2,3"` → 3 envelopes
   - happy: human-mode rendering snapshot (single id)
   - dry-run: no HTTP; envelope has `dry_run: true` + `would.method: 'POST'` + `would.path: '/project/9001/archive'`
   - stdin: NDJSON input → ordered NDJSON output, `line_index` carried per line
   - validation: bad `<id>` (non-integer) → exit 2
   - validation: `--ids ""` → exit 2
   - validation: combining positional + `--ids` → exit 2
   - api: 401 → exit 3
   - api: 403 → exit 4
   - api: 404 (project not found) → exit 4 (NOT idempotent — only DELETE re-classifies)
   - api: 422 → exit 4
   - api: 429 → exit 6, retryable
   - api: 5xx → exit 4
   - network: `HttpResponse.error()` → exit 5
   - introspect: `freelo --introspect` includes `projects archive` with `output_schema: 'freelo.projects.archive/v1'`, `destructive: false`

10. **`test/commands/projects/activate.test.ts`** — same row matrix, swapping `archive` → `activate`, `archived` → `active`, `/archive` → `/activate`. Plus one extra row:
    - api: 422 with `PlanExceededException` body → exit 4, server message in `errors[]` (decision 8)

11. **`test/commands/projects/delete.test.ts`** — destructive command row matrix. Mirrors `tasks/delete.test.ts`:
    - happy: single id with `--yes` → envelope, exit 0
    - happy: single id, TTY confirm `y` → envelope (calibration §7: `delete process.env['CI']`)
    - happy: NDJSON batch with `--yes` → ordered output, line_index
    - happy: human-mode snapshot
    - dry-run: skips both confirm and HTTP
    - 404 → `already_in_target_state: true` envelope, exit 0
    - 401/403/422/429/5xx — all error matrix rows
    - non-TTY without `--yes` → `CONFIRMATION_REQUIRED` exit 2 (no HTTP fired)
    - TTY user declines → `CONFIRMATION_REQUIRED` exit 2 (no HTTP fired)
    - Combining positional + `--ids` → exit 2
    - Bad `<id>` → exit 2
    - Empty stdin with `--yes` → silent exit 0
    - Confirmation copy assertion (TTY mode): the prompt message contains `"soft-delete"` and `"projects activate"`. Calibration §7: `delete process.env['CI']` for the duration of the test.

12. **`test/api/projects-transition.test.ts`** — pure unit test for `projectsTransitionPath`. No I/O.

13. **`test/api/projects-delete.test.ts`** — pure unit test for `projectDeletePath`. No I/O.

14. **`test/fixtures/projects/archive-success.json`** — `{"result": "success"}`. Reused for all transition success cases.

15. **`test/fixtures/projects/delete-success.json`** — same.

16. **`docs/commands/projects-archive.md`** — VitePress page: synopsis, flags, two examples, link to envelope schema, note on idempotency.

17. **`docs/commands/projects-activate.md`** — same shape; notes the dual unarchive/undelete semantic.

18. **`docs/commands/projects-delete.md`** — same shape; notes soft-delete reversibility, links to `projects activate`.

19. **`.changeset/<random-hash>.md`** — `freelo-cli: minor` — "Add `freelo projects archive` / `projects activate` / `projects delete` (R30). New envelope schemas: `freelo.projects.archive/v1`, `freelo.projects.activate/v1`, `freelo.projects.delete/v1` (all additive). Reuses Wave 2-4 shared write infra (`--dry-run`, `--ids`/`--stdin` batch, `confirmDestructive`)."

#### Modified files

20. **`src/api/schemas/project.ts`** — append the §5 types (no zod schemas; the wire response is `SuccessResponse` and lives inline in the wrapper files).

21. **`src/commands/projects.ts`** — register the three new leaves (three new imports + three `register*(projects, ...)` calls).

22. **`test/msw/handlers.ts`** — append two namespaces:
    - `projectsArchiveActivateHandlers` factory: `ok(verb)`, `unauthorized(verb)`, `forbidden(verb)`, `notFound(verb)`, `unprocessable(verb, message?)`, `rateLimited(verb)`, `serverError(verb, status?)`, `networkError(verb)`. Each takes a verb so the same factory wires both `archive` and `activate` paths.
    - `projectsDeleteHandlers` factory: `ok()`, `notFound()` (the idempotent path), `unauthorized()`, `forbidden()`, `unprocessable(message?)`, `rateLimited()`, `serverError(status?)`, `networkError()`.

23. **`README.md`** — autogen Commands block — regenerated by `pnpm fix:readme` in the doc phase. **Do not hand-edit.**

24. **`docs/specs/0043-projects-archive-activate-delete.md`** — this file.

25. **`docs/roadmap.md`** — append a "✅ shipped" marker to R30 entry **after** PR is merged (not in this PR).

#### No-touch (paranoia checklist)

- `src/config/**` — none.
- `src/api/client.ts` — none.
- `src/bin/freelo.ts` — none.
- `src/errors/**` — no new error classes.
- `src/lib/dry-run.ts`, `src/lib/batch.ts`, `src/lib/idempotency.ts`, `src/lib/confirm.ts` — reused unchanged.

### 11. Dependencies

**No new runtime deps. No new dev deps.**

### 12. Test strategy

- **Unit** layer: path builders in `test/api/projects-transition.test.ts` + `test/api/projects-delete.test.ts`. No I/O, no MSW.
- **Integration** layer: three command-level test files boot the program end-to-end with MSW handlers.
- **Coverage targets**: 80% lines / 90% on `src/api/` and `src/commands/`. Each new try/catch arm in `projects/delete.ts` (the 404→idempotent re-classify and the per-line `toBaseError` fallback) gets explicit coverage (calibration §4).
- **Calibration §2**: every typed error class triggered (`ValidationError`, `ConfirmationError`, `FreeloApiError`, `RateLimitedError`, `NetworkError`) has at least one exit-code-asserting test per command.
- **Calibration §7**: any test asserting TTY-prompt copy clears `process.env['CI']` for the duration. The `delete` command's "prompt copy contains 'soft-delete'" test uses the exact pattern from `test/lib/env.test.ts:50-58`.

### 13. Slicing

R30 is one slice (~700 LOC including tests). The three commands share a verb-shared module (transition.ts) so the per-command marginal cost is small. No need to subdivide.

If during implementation the spec's actual file count or LOC overruns by >50%, pause and re-plan.

### 14. Implementation order

1. Append §5 types to `src/api/schemas/project.ts` (no logic — just shape).
2. Write `src/api/projects-transition.ts`. Unit-test `projectsTransitionPath`.
3. Write `src/api/projects-delete.ts`. Unit-test `projectDeletePath`.
4. Write `src/commands/projects/transition.ts` + `archive.ts` + `activate.ts`.
5. Write `src/ui/human/projects-transition.ts`.
6. Append `projectsArchiveActivateHandlers` to `test/msw/handlers.ts`.
7. Integration-test `projects archive` + `projects activate` against MSW.
8. Write `src/commands/projects/delete.ts`.
9. Write `src/ui/human/projects-delete.ts`.
10. Append `projectsDeleteHandlers` to `test/msw/handlers.ts`.
11. Integration-test `projects delete`.
12. Wire into `src/commands/projects.ts`.
13. `pnpm typecheck && pnpm lint && pnpm test --coverage && pnpm build && pnpm check:readme` on a clean tree (calibration §3).
14. Add changeset, regen README via `pnpm fix:readme`, commit, push, open PR.

### 15. Risk callouts for the implementer

- **Calibration §1** — when interrupted, run **every** remaining phase before pushing.
- **Calibration §2** — every typed error class in §4 must have an exit-code-asserting test, per command.
- **Calibration §3** — gates run on the **committed** tree post-commit, not the working tree.
- **Calibration §4** — the new try/catch arms in `projects/delete.ts` (404 re-classify; `toBaseError` per-line fallback) need dedicated tests.
- **Calibration §6** — already on a clean `main` synced to `edfac24`.
- **Calibration §7** — TTY-prompt-copy tests MUST `delete process.env['CI']` and restore in finally.
- **Decision 1 is load-bearing** — the implementer should NOT add a GET pre-check "to be safe". The pre-check would force handling the 404-on-deleted edge case; without it, the server's documented idempotency carries us through cleanly.
- **`projects activate` is the ONLY one of the three with two semantically different success outcomes** (unarchive vs. undelete). The CLI surfaces both as `current_state: 'active'` — agents should not infer "the project was previously archived" from a successful `activate`.
- **The variadic `<id>...` argument carries through three commands.** Reuse the `parsePositiveInt('<id>', raw)` and `collectTaskId` shape from R11/R13; rename the closure local to `parseProjectId` / `collectProjectId` for clarity.

ARCHITECT run=2026-05-09-0917-r30 status=ok spec=docs/specs/0043-projects-archive-activate-delete.md open_questions=0 new_deps=0
