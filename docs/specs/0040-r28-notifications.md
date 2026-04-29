# Spec 0040 — R28 `freelo notifications`

**Run:** 2026-04-29-2030-r28-notifications
**Tier:** Yellow
**Depends on:** R01 (auth, established).
**Sibling, NOT shared with:** R23 `labels`, R24 `task-labels`, R25–R27 `files` — independent resource group with its own endpoints, schemas, and precedent.

---

## 1. Problem & scope

Freelo's notification feed is currently invisible to the CLI. Agents that mirror Freelo activity into Slack / email / dashboards have to either poll the web UI or implement a bespoke fetch against the (undocumented-from-CLI) endpoint. R28 wires the three first-class notification endpoints into a typed, paginated, idempotent CLI surface.

```
freelo notifications list   [--unread] [--page N | --all] [--project <id>...] [--type <wire>]
freelo notifications read   <id>... | --ids <list> | --stdin | --all-unread   [--dry-run]
freelo notifications unread <id>... | --ids <list> | --stdin                  [--dry-run]
```

### Goals

- Wire-faithful coverage of all three notification endpoints, end-to-end (CLI → typed API wrappers → MSW-tested).
- Three additive envelope schemas: `freelo.notifications.list/v1`, `freelo.notifications.read/v1`, `freelo.notifications.unread/v1`.
- Agent-safe writes: positional `<id>...` + `--ids` + `--stdin` (NDJSON), `--dry-run`, server-side idempotency surfaced honestly.
- `--all-unread` convenience flag on `read` that drains the unread feed in pages, then POSTs each id.

### Non-goals (v1)

- A `notifications show <id>` (no GET-single endpoint exists in the API).
- Filtering by `users_ids[]`, `teams_uuids[]`, `notification_types[]`, `order` on the list — wire fields are documented, but only `--project` (mapping to `projects_ids[]`) and `--type` (mapping to `notification_types[]` as a single value) are surfaced in v1; the rest can be added later if real workloads ask. **Decision 04.**
- A `--mark-read` flag on `notifications list` (R20 has `comments list --mark-read`; precedent exists) — out of scope; do it explicitly with `notifications read` after listing.
- A `notifications mark-all-as-read` aggregate endpoint — Freelo doesn't expose one; `--all-unread` on `read` is the closest substitute and is opt-in.

---

## 2. OpenAPI verification

Verified against `docs/api/freelo-api.yaml`:

### 2.1 `GET /all-notifications` (yaml :3619-3694)

**Query parameters:**

| Param | Type | CLI mapping (v1) |
|---|---|---|
| `projects_ids[]` | int[] | `--project <id>` (repeatable) |
| `users_ids[]` | int[] | NOT surfaced v1 (decision 04) |
| `teams_uuids[]` | uuid[] | NOT surfaced v1 (decision 04) |
| `order` | enum `asc|desc` | NOT surfaced v1 (server default `desc`) |
| `notification_types[]` | string[] | `--type <s>` (single value, repeatable) |
| `only_unread` | boolean | `--unread` (boolean flag; sends `only_unread=true` only when set) |
| `p` | integer (0-indexed, default 0) | `--page <n>` (1-indexed CLI → 0-indexed wire) / `--all` |

**Response 200 shape** (verbatim from yaml :3678-3694):

```yaml
allOf:
  - PaginatedResponse           # { total, count, page, per_page }
  - type: object
    properties:
      data:
        type: object
        properties:
          notifications:
            type: array
            items: $ref Notification
```

Inner key for `normalizePaginated`: `notifications`.

**`Notification`** (yaml :5841-5901):

```yaml
id: integer                              # required
type: string                             # required (e.g. "task_assigned", "comment_created")
date_action: string (date-time)
author: UserBasic { id, fullname }
who: UserBasic
is_unread: boolean                       # critical signal — drives `--all-unread`
is_new: boolean
task: { id, name } | null
tasklist: TasklistBasic { id, name }
project: ProjectBasic { id, name }
comment: { id } | null
document: { id, name } | null
file: { uuid, filename, caption } | null
more_comments: boolean
more_users: UserBasic[]
```

Per `.claude/docs/conventions.md` §API client, every `.optional()` chain is `.nullable().optional()` — Freelo uses absent and null interchangeably. The schema uses `.passthrough()` per the established R03/R09 pattern.

### 2.2 `POST /notification/{notification_id}/mark-as-read` (yaml :3696-3724)

- Path param: `notification_id` (integer).
- No request body documented.
- Response 200: generic `SuccessResponse` (`{ result?: string }`).
- **Idempotent — calling on an already-read notification returns 200** (yaml :3709, verbatim).
- 404 if the notification does not exist or does not belong to the caller (yaml :3710).

### 2.3 `POST /notification/{notification_id}/mark-as-unread` (yaml :3726-3753)

- Identical to mark-as-read in shape. Idempotent (yaml :3739).

### 2.4 No GET-single endpoint

There is no `GET /notification/{id}` in the OpenAPI. **The CLI cannot pre-check the current state of a notification by id.** This is the structural difference vs. R11 `tasks finish` (which has `getTaskDetail` for the pre-check). Implication for spec §3.4 — see decision 03.

---

## 3. CLI surface

### 3.1 Command tree (registered in `src/bin/freelo.ts`)

```
freelo notifications                                               [parent — no meta]
  ├─ list   [--unread] [--page N|--all] [--project <id>...] [--type <s>]
  │                                              [meta: freelo.notifications.list/v1]
  ├─ read   <id>... | --ids <list> | --stdin | --all-unread [--dry-run]
  │                                              [meta: freelo.notifications.read/v1]
  └─ unread <id>... | --ids <list> | --stdin                [--dry-run]
                                                 [meta: freelo.notifications.unread/v1]
```

Parent has description, no `meta` (mirrors `freelo files`, `freelo task-labels`, `freelo labels`).

### 3.2 Flag specification — `notifications list`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `--unread` | boolean | no | When set, sends `only_unread=true`. Default off → server returns all notifications. |
| `--page <n>` | int ≥ 1 | no | CLI 1-indexed → wire 0-indexed. Mutex with `--all`. |
| `--all` | boolean | no | Iterate every page. Mutex with `--page`. |
| `--project <id>` | int (repeatable) | no | Maps to `projects_ids[]`. |
| `--type <s>` | string (repeatable) | no | Maps to `notification_types[]`. Free-form (server is the authority). |

Output schema: `freelo.notifications.list/v1`.

### 3.3 Flag specification — `notifications read`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `<id>...` | int (positional, variadic) | one of these | Positive int per token. |
| `--ids <list>` | comma/space-separated ints | one of these | Same parser as R11. |
| `--stdin` | boolean | one of these | NDJSON `{"id": <int>}` per line. |
| `--all-unread` | boolean | one of these | List unread (paged), then POST each id. |
| `--dry-run` | boolean | no | Echo wire body in `would`; no POST. With `--all-unread`, the list call still runs (to know **what** would be POSTed); echoed paths are per-id. |

Mutex: exactly one of `<id>...`, `--ids`, `--stdin`, `--all-unread`. Empty resolution → silent success exit 0 (mirrors R11/R19 batch convention).

Output schema: `freelo.notifications.read/v1`.

### 3.4 Flag specification — `notifications unread`

| Flag | Type | Required | Notes |
|---|---|---|---|
| `<id>...` | int (positional, variadic) | one of these | Positive int per token. |
| `--ids <list>` | comma/space-separated ints | one of these | |
| `--stdin` | boolean | one of these | NDJSON `{"id": <int>}` per line. |
| `--dry-run` | boolean | no | Echo wire body in `would`; no POST. |

**No `--all-unread`** — the API doesn't surface "all read" notifications (the `only_unread` filter only goes one way). Per-roadmap signature confirms.

Output schema: `freelo.notifications.unread/v1`.

### 3.5 Output

#### 3.5.1 `freelo.notifications.list/v1`

```ts
type NotificationsListData = {
  applied_filters: {
    only_unread?: true;            // present only when --unread set
    projects?: number[];
    types?: string[];
  };
  items: Notification[];           // matches the Notification schema (passthrough)
};
```

Envelope carries `paging` (PaginatedResponse: page/per_page/total/next_cursor) and `rate_limit`. NDJSON streaming on `--all` follows the precedent in `files list` / `reports list`.

#### 3.5.2 `freelo.notifications.read/v1` and `freelo.notifications.unread/v1`

Per-id envelope (one per id; emitted as NDJSON in batch mode, single envelope for single-id mode — same shape as R11):

```ts
type NotificationsReadData = {
  notification_id: number;
  posted: true;                            // always true when the POST 200'd
  // server-side idempotency: we cannot know if it was already-read,
  // so no `already_in_target_state` field. (Decision 03.)
  source?: 'all-unread';                   // present only when --all-unread drove this id
  line_index?: number;                     // present only on --stdin source
  input_index?: number;                    // present only on positional/--ids source for batch (>1 id)
  would?: { method: 'POST'; path: '/notification/<id>/mark-as-read'; body: {} };
};

type NotificationsUnreadData = {
  notification_id: number;
  posted: true;
  line_index?: number;
  input_index?: number;
  would?: { method: 'POST'; path: '/notification/<id>/mark-as-unread'; body: {} };
};
```

For `--all-unread`: the orchestrator emits a leading `notice` envelope on stderr (or as a pre-roll envelope in NDJSON mode) summarizing the count, then the per-id envelopes. **Decision 02** records the exact shape.

### 3.6 Error paths & exit codes

| Scenario | Error class | Exit code |
|---|---|---|
| `<id>` non-numeric / non-positive | `ValidationError` | 2 |
| `--ids` empty / non-numeric token | `ValidationError` | 2 |
| `--stdin` line not valid JSON | `ValidationError` | 2 |
| `--stdin` line missing/wrong-type `id` | `ValidationError` | 2 |
| Combining input sources (`<id>` + `--ids`, `--stdin` + `--all-unread`, etc.) | `ValidationError` | 2 |
| `--page` and `--all` together | `ValidationError` | 2 |
| `--all-unread` on `unread` (flag does not exist) | Commander's unknown-option → exit 1 | 1 (Commander default) |
| 4xx from server (e.g. 404 unknown id) | `FreeloApiError` | 4 |
| 401 (auth expired) | `FreeloApiError` (`code: AUTH_EXPIRED`) | 3 |
| 403 / 5xx | `FreeloApiError` | 4 |
| 429 | `RateLimitedError` | 6 |
| Network failure | `NetworkError` | 5 |

Per Calibration §2 the test plan (§7) MUST assert each `exitCode` for each typed-error path.

### 3.7 Idempotency policy

The two write endpoints are server-side idempotent (yaml :3709, :3739). The CLI cannot pre-check (no GET-single), so it always POSTs. **No `already_in_target_state` field is emitted.** Comment in envelope schema documents this: "Server-side idempotent; the CLI cannot distinguish first-mark from re-mark — agents that need that signal must observe the `is_unread` value via `notifications list` before/after." (Decision 03.)

### 3.8 `--all-unread` semantics

1. Resolve credentials, build client.
2. Fetch all unread notifications via `fetchAllPages` over `GET /all-notifications?only_unread=true&p=N`.
3. Extract `id` from each notification.
4. POST `mark-as-read` per id, in input order.
5. On any per-id failure: emit per-id error envelope, accumulate exit code (highest wins), continue with remaining ids.
6. If the **list** call fails before any per-id POST: bubble up as the top-level error (no partial-success envelope possible).
7. If the list call partially succeeds (`PartialPagesError`): emit a `notice` envelope, then process the partial set, then re-throw the partial cause as exit code.

**Confirmation gate:** `--all-unread` does **not** require `--yes`. Marking notifications as read is reversible (`notifications unread` exists), so it is **not** destructive in the calibration sense (data loss / hard-to-reverse). Matches R11 `tasks finish` precedent (which doesn't gate on `--yes` either). Decision 02 records this; PR body flags it for review.

**Empty unread set:** `--all-unread` with zero results emits a single `notice: 'No unread notifications.'` envelope and exits 0. (Same precedent: R11 `tasks finish` with empty resolution exits silently 0; here we add a `notice` because the user actively asked to drain the feed and a silent no-op would be confusing.) Decision 06.

### 3.9 Renderer (`human` mode)

Three small renderers in `src/ui/human/`:

- `notifications-list.ts` — table of `id, type, date_action, project, task/tasklist, is_unread`. ~50 LOC.
- `notifications-mark.ts` — one-liner per id. Shared between `read` and `unread` (the verb is parameterized). ~25 LOC.

---

## 4. Files & module layout

### 4.1 New files

| File | Purpose |
|---|---|
| `src/api/notifications.ts` | Wire wrappers for the three endpoints + path helpers. ~120 LOC. |
| `src/api/schemas/notification.ts` | Zod schemas: `NotificationSchema` (passthrough, all leaves nullable+optional except `id`), `NotificationsListAppliedFilters`, `NotificationsListData`, `NotificationsReadData`, `NotificationsUnreadData`. ~100 LOC. |
| `src/commands/notifications.ts` | Parent registrar (mirrors `task-labels.ts`). ~30 LOC. |
| `src/commands/notifications/list.ts` | Leaf — paged list with filters. ~200 LOC. |
| `src/commands/notifications/read.ts` | Leaf — mark-as-read. Imports shared mark logic from `mark.ts`. ~80 LOC. |
| `src/commands/notifications/unread.ts` | Leaf — mark-as-unread. Imports shared mark logic from `mark.ts`. ~60 LOC. |
| `src/commands/notifications/mark.ts` | Shared transition logic for `read` + `unread` (mirrors `tasks/transition.ts` shape). ~280 LOC. |
| `src/ui/human/notifications-list.ts` | Human renderer (table). ~50 LOC. |
| `src/ui/human/notifications-mark.ts` | Human renderer (one-liner). ~30 LOC. |
| `test/api/notifications.test.ts` | Wire-wrapper unit tests (MSW). ~120 LOC. |
| `test/commands/notifications/list.test.ts` | List command tests. ~250 LOC. |
| `test/commands/notifications/read.test.ts` | Read tests + `--all-unread` + per-id error paths. ~300 LOC. |
| `test/commands/notifications/unread.test.ts` | Unread tests. ~200 LOC. |
| `.changeset/r28-notifications.md` | Minor bump — three new subcommands + three new schemas. |

### 4.2 Modified files

| File | Change |
|---|---|
| `src/bin/freelo.ts` | Add `import { register: registerNotifications } from '../commands/notifications.js'` and call site. |
| `README.md` | Auto-generated by `pnpm fix:readme` from introspection — no hand edits expected. |

**Total file touches:** 13 new + 2 modified = **15 files**. Within budget (25). At the high end of the soft warning level — flagged for review.

---

## 5. Behavioral details

### 5.1 List shape

- Page mode: `--page N` (1-indexed CLI) → `?p=N-1`. Default = first page (`?p=0`).
- All mode: `fetchAllPages` over `getAllNotifications(client, { page, filters })`. Mid-stream failure after at least one page → `PartialPagesError` with partial envelope + `notice`. Mirrors `files list` precedent byte-for-byte.
- Server-side filtering: `--unread`, `--project`, `--type` all map to wire query params. No client-side post-filter.

### 5.2 Read / unread shape

- Single-id mode (`<id>` only one positional, no `--ids`/`--stdin`/`--all-unread`): single envelope on stdout, errors bubble to top-level handler.
- Multi-id / `--stdin` / `--all-unread`: per-id envelopes (NDJSON), errors per-id with `ExitCodeAccumulator`. Mirrors `tasks transition.ts` byte-for-byte except:
  1. **No pre-check GET**: skip the `getTaskDetail` step entirely. Always POST (or echo `would` on `--dry-run`).
  2. **No `already_in_target_state`**: the field is omitted from the envelope (decision 03).
  3. `--all-unread` is a fourth source (input shape: a paged GET, then a `number[]` extracted from `data[].id`).

### 5.3 `--dry-run` per-id

Each per-id envelope carries `dry_run: true` (top-level) and `data.would = { method: 'POST', path: '/notification/<id>/mark-as-read', body: {} }`. With `--all-unread + --dry-run`, the list call still runs (so the user sees what *would* be POSTed); list-call failures during dry-run bubble normally.

### 5.4 Empty-input handling

- Positional `<id>...` with zero tokens → silent success exit 0 (commander treats variadic as empty array).
- `--ids ""` → `ValidationError` (parser explicitly rejects empty token list).
- `--stdin` with zero lines → silent success exit 0 (R11 precedent).
- `--all-unread` with zero unread → emit a single `notice` envelope, exit 0 (decision 06).

### 5.5 No destructive prompt

Marking notifications as read/unread is reversible — neither command is destructive. No `confirmDestructive`, no `--yes` flag exposed at the command level. **Calibration #7 (TTY-prompt CI gotcha) does not apply** to this slice.

### 5.6 Lazy-load discipline

- Command files import `commander`, `zod`, the api wrapper, the renderers (small, no human-only deps), and the typed-error classes. None of `@inquirer/prompts`, `ora`, `boxen`, `cli-table3`, `chalk`, `pino-pretty` appear at top-level.
- The list renderer formats inline (string concatenation, ASCII columns) — no `cli-table3` for v1 (matches `comments list`, `reports list`).

---

## 6. Conventions touched

- **Error classes**: `ValidationError` (input), `FreeloApiError` (4xx/5xx), `RateLimitedError` (429), `NetworkError` (transport).
- **Envelope contract**: three new schemas, all additive `vN`. Changeset minor.
- **Schema policy**: `Notification` schema is `.passthrough()`; every `.optional()` is `.nullable().optional()` (R05.5 / spec 0010 decision 1).
- **ESM-only**: every relative import uses `.js`.
- **No top-level static imports** of human-UX libs.

---

## 7. Test plan

Coverage targets per project policy: 85% branch on `src/commands/**`. Test count target: **~40 tests** across 4 files.

### 7.1 `test/api/notifications.test.ts` (~10 tests)

- `getAllNotifications` builds correct query string for: `?p=0` only; with `only_unread=true`; with `projects_ids[]=A&projects_ids[]=B`; with `notification_types[]=task_assigned`; combination of all.
- `getAllNotifications` parses through `normalizePaginated` with inner key `notifications`.
- `markNotificationAsRead` POSTs to the right path.
- `markNotificationAsUnread` POSTs to the right path.
- 4xx (404) → `FreeloApiError` propagation for read/unread.
- 5xx → `FreeloApiError`.

### 7.2 `test/commands/notifications/list.test.ts` (~10 tests)

- Happy path (default `?p=0`) — exit 0, envelope shape with `paging` + `rate_limit`.
- `--unread` — wire request includes `only_unread=true`.
- `--project 1 --project 2` — wire request includes both `projects_ids[]`.
- `--type task_assigned --type comment_created` — wire request includes both `notification_types[]`.
- `--page 3` — wire request hits `?p=2` (1-indexed → 0-indexed).
- `--all` — `fetchAllPages` iterates 3 pages, merged envelope total matches.
- `--page 1 --all` → `ValidationError`, exit 2.
- `--page 0` → `ValidationError`, exit 2 (positive int).
- `--page abc` → `ValidationError`, exit 2.
- 401 from server → `FreeloApiError`, exit 1; envelope shape on stderr.
- Human output smoke test (TTY-spoof; `delete process.env.CI` not needed because no `isInteractive`-gated branch in this command).

### 7.3 `test/commands/notifications/read.test.ts` (~14 tests)

- Single positional id `42` — single success envelope on stdout.
- Multiple positional ids `42 43 44` — three NDJSON envelopes.
- `--ids "1,2,3"` — three NDJSON envelopes.
- `--ids "1 2 3"` (space separator) — three NDJSON envelopes.
- `--stdin` with three NDJSON lines — three envelopes, `line_index` populated.
- `--stdin` with one bad JSON line and one good — one error envelope (line_index 0), one success envelope (line_index 1), exit 2.
- `--all-unread` with two unread → two POSTs, two success envelopes.
- `--all-unread` with **zero** unread → single `notice` envelope, exit 0 (decision 06).
- `--dry-run` (single id) — no POST, envelope has `dry_run: true` and `would`.
- `--dry-run` with `--all-unread` — list call still runs; per-id envelopes carry `would`; no POSTs.
- Combining `<id>` + `--ids` → `ValidationError`, exit 2 (cross-source check).
- Combining `--ids` + `--stdin` → `ValidationError`, exit 2.
- Combining `--all-unread` + positional → `ValidationError`, exit 2.
- 404 on a single id (multi-id mode) — per-id error envelope; other ids succeed; exit 1.
- `<id 0>` → `ValidationError`, exit 2.
- `<id abc>` → `ValidationError`, exit 2.

### 7.4 `test/commands/notifications/unread.test.ts` (~8 tests)

- Single positional id — success envelope.
- Multiple positional ids — NDJSON envelopes.
- `--ids` — happy path.
- `--stdin` — happy path with 2 lines.
- `--dry-run` — no POST, `would` echoed.
- 404 on single id → `FreeloApiError`, exit 1.
- 5xx on multi-id → per-id error env, exit 1.
- Combining `<id>` + `--ids` → `ValidationError`, exit 2.

### 7.5 Coverage of typed-error classes (Calibration §2)

- `ValidationError` (exit 2): yes, multiple per file.
- `FreeloApiError` (exit 1): yes, one per command-level file.
- `RateLimitedError` (exit 4) / `NetworkError` (exit 5): covered by api-wrapper tests + general client.ts coverage; not duplicated per command (they share the same client.ts code path that's already tested).

### 7.6 Calibration #4 check (try/catch coverage drift)

The shared `mark.ts` introduces ~3 catch arms (one in `runBatchFromStdin`, one in `runIdList`, one in `runAllUnread`). Each is covered by:
- `runBatchFromStdin` catch — read.test.ts: 4xx during stdin batch → per-id error env.
- `runIdList` catch — read.test.ts: 404 in multi-id mode.
- `runAllUnread` catch — read.test.ts: 4xx during per-id POST after a successful list.

### 7.7 Calibration #7 check (TTY-prompt CI gotcha)

No `isInteractive()`-gated TTY-prompt branch in this slice → no `delete process.env.CI` needed. Will grep test diff for `isTTY.*true` before submit; expect zero matches.

---

## 8. Open questions

None. All API behavior is documented in the OpenAPI yaml; all flag semantics derive from the roadmap signature; all output schema choices follow the task-labels / files / tasks-transition precedent.

---

## 9. Acceptance criteria

- [ ] All three commands registered and discoverable via `freelo --introspect`.
- [ ] All three commands pass their happy-path test against MSW.
- [ ] Each typed-error path has an exit-code assertion (Calibration §2).
- [ ] `pnpm typecheck && pnpm lint && pnpm test && pnpm build && pnpm check:readme` green on the committed tree (Calibration §3).
- [ ] Changeset entry calls out the three new schemas.
- [ ] No new dependencies.
- [ ] Coverage on `src/commands/notifications/**` ≥ 85% branch.

---

## 10. Decision log (resolved during spec)

### Decision 01 — Pagination shape: `--page <n>` (1-indexed CLI) → `?p=N-1` (0-indexed wire)

The wire is 0-indexed (yaml :4769 `default: 0`). Every other paginated CLI command in the repo (`projects list`, `tasks list`, `comments list`, `files list`, `reports list`) presents `--page <n>` as 1-indexed for human ergonomics and translates internally. R28 follows the precedent.

### Decision 02 — `--all-unread` on `read` does NOT require `--yes`

Marking notifications as read is reversible (`notifications unread` exists). Per the calibration definition of "destructive" (data-loss / hard-to-reverse), this does not qualify. Match R11 `tasks finish --ids 1,2,3,...` which doesn't gate either. Tradeoff: we lose a "are you sure you want to drain 200 unread items" prompt, but adding it would be friction with no security benefit and inconsistent with sibling commands. Flagged for human review in PR body. (Per autonomous-sdlc.md: "New user-facing flag name or short form" → "Decide, log, flag for review in PR body".)

### Decision 03 — No pre-check GET; envelope omits `already_in_target_state`

There is no `GET /notification/{id}` endpoint. The CLI cannot know whether a notification was already-read before POSTing. Three alternatives:
  A. Pre-fetch the unread feed and intersect with input ids — adds an extra GET + paging burden for the common case (mark-by-id).
  B. Skip pre-check; emit `already_in_target_state: false` always — misleading.
  C. **Skip pre-check; omit the field entirely; document server-side idempotency in envelope schema comments.**
We pick C. The schema docstring says: "Server-side idempotent; the CLI cannot distinguish first-mark from re-mark — agents that need that signal must observe `is_unread` via `notifications list` before/after."

### Decision 04 — Surface only `--unread`, `--project`, `--type` on list (not `--user`, `--team`, `--order`)

The OpenAPI documents `users_ids[]`, `teams_uuids[]`, `order` query params. Surfacing them all would expand the v1 surface and the test matrix. The roadmap signature only mentions `--unread` and pagination flags. Keep v1 minimal; `--project` and `--type` are added because they are the two filters most likely to be useful for digest / Slack / Teams integrations (the documented use cases in yaml :3627-3631). Follow-up if real workloads need the others.

### Decision 05 — Notification schema is permissive (`.passthrough()`, all-leaves-nullable+optional)

Same convention as every other entity schema in the repo (R05.5 lessons). The wire schema documents 13 fields; production responses likely carry more. We surface what's there, never reject on unknown fields.

### Decision 06 — `--all-unread` with zero unread emits a `notice` envelope, not silent

R11 batch convention is "empty resolution → silent success exit 0". We deviate here because `--all-unread` is an *active intent* (the user said "drain my inbox"). A silent no-op for that input is confusing for both humans and agents — they got no signal whether the operation ran. Emit one envelope:

```json
{ "schema": "freelo.notifications.read/v1", "data": { "items": [] }, "notice": "No unread notifications." }
```

Wait — that doesn't match the schema (data shape is per-id elsewhere). Actually emit a **single non-data envelope** with just `notice` and `data: { items: [] }` — same shape as `--all-unread + dry-run` would emit if the list was empty. The schema admits `items` as optional via `.passthrough()` (or — cleaner — emit an envelope with `notice` and `data` shaped as the per-id structure but with `notification_id: null` and `posted: false`). Reconcile in implement: simplest is a top-level envelope `{ schema, notice, data: { items: [] } }`. The `notifications.read/v1` schema's runtime data zod allows this via permissive shape — see api/schemas/notification.ts in plan.

### Decision 07 — One pluggable `mark.ts` shared between `read` and `unread`

Same pattern as `tasks/transition.ts` (R11 spec 0021). The two verbs share input parsing, batch flow, error classification, and envelope shape — only the wire path and schema discriminant differ. One file, two registrar exports. Reduces duplication and makes the `--all-unread` injection point obvious (it lives in the `read` registrar, threading down to the shared run loop).

---

## 11. Plan (file-level TODOs)

### Step 1 — Schemas (no deps)

**File:** `src/api/schemas/notification.ts` (new, ~100 LOC)

- `NotificationSchema` — passthrough; required `id`; `type`, `date_action`, `is_unread`, `is_new` permissive (nullable+optional); embedded `author`, `who` use shared `UserBasicSchema` from `project.ts` (which already exposes it). `task`, `comment`, `document`, `file` are nested `.nullable().optional().object().passthrough()`. `tasklist` and `project` use `.nullable().optional()` referencing the existing basic schemas (Tasklist/ProjectBasic — re-export or define inline).
- `NotificationsListAppliedFiltersSchema` — `{ only_unread?: literal(true); projects?: number[]; types?: string[] }`.
- `NotificationsListDataSchema` — `{ applied_filters; items: NotificationSchema[] }`.
- `NotificationsReadDataSchema` — per-id success shape with optional `would`, `line_index`, `input_index`, `source`. Permissive (passthrough) so the `--all-unread` empty-set notice envelope variant remains valid.
- `NotificationsUnreadDataSchema` — same shape minus `source` (no `--all-unread` for unread).
- `SuccessResponseSchema` — local `{ result?: string }.passthrough()` (mirrors `task-label.ts`).

### Step 2 — API wrappers

**File:** `src/api/notifications.ts` (new, ~120 LOC)

- `ALL_NOTIFICATIONS_PATH = '/all-notifications'`
- `markNotificationReadPath(id) = '/notification/<id>/mark-as-read'`
- `markNotificationUnreadPath(id) = '/notification/<id>/mark-as-unread'`
- `AllNotificationsFilters` type (`only_unread?: boolean; projects?: number[]; types?: string[]`).
- `getAllNotifications(client, { page, filters, signal?, requestId? })` — builds query via `buildQuery`, calls `client.request({ schema: z.unknown() })`, then `normalizePaginated(raw.data, 'notifications', NotificationSchema)`.
- `markNotificationAsRead(client, id, opts)` / `markNotificationAsUnread(client, id, opts)` — POST with empty body, `SuccessResponseSchema`.

### Step 3 — Human renderers

**File:** `src/ui/human/notifications-list.ts` (new, ~50 LOC)
- `renderNotificationsListHuman(d)` — header + one line per item with `id, type, project, task/tasklist, is_unread`, simple ASCII column padding.

**File:** `src/ui/human/notifications-mark.ts` (new, ~30 LOC)
- `renderNotificationsMarkHuman(d, verb: 'read' | 'unread')` — single-line per id.
- `renderBatchItemFailureHuman(index, idMaybe, message)` — borrow R11's batch error renderer shape.

### Step 4 — Shared mark.ts

**File:** `src/commands/notifications/mark.ts` (new, ~280 LOC)

- Mirrors `src/commands/tasks/transition.ts` structurally (input parsing, batch streamer, ExitCodeAccumulator, error envelope writer). Diffs:
  - **No `getTaskDetail`-style pre-check** — runOneId only POSTs (or echoes `would`).
  - **No `already_in_target_state`** field on the envelope.
  - **Adds `runAllUnread`** path that:
    1. Fetches all unread via `fetchAllPages(getAllNotifications)`.
    2. Extracts `id`s.
    3. If empty → emit `notice` envelope (decision 06) and return.
    4. Otherwise → loop over ids the same way as `--ids` mode, with `source: 'all-unread'` on each per-id envelope.
- Two registrar exports: `registerRead`, `registerUnread`.
- Each registrar wires its own `wiring: VerbWiring` (`{ verb, schema, supportsAllUnread }`).

### Step 5 — Leaf commands

**File:** `src/commands/notifications/read.ts` (new, ~30 LOC) — re-exports `registerRead` from `./mark.js` (mirrors `tasks/finish.ts`).

**File:** `src/commands/notifications/unread.ts` (new, ~30 LOC) — re-exports `registerUnread`.

**File:** `src/commands/notifications/list.ts` (new, ~200 LOC) — mirrors `src/commands/files/list.ts` byte-for-byte except for filter building and the renderer import.

### Step 6 — Parent registrar

**File:** `src/commands/notifications.ts` (new, ~30 LOC) — mirrors `task-labels.ts`.

### Step 7 — Wire into root

**File:** `src/bin/freelo.ts` (modify) — `import { register: registerNotifications } from '../commands/notifications.js'` and call.

### Step 8 — Tests

Four files per §7.

### Step 9 — Changeset

```
.changeset/r28-notifications.md
"freelo-cli": minor

feat(commands): r28 — `freelo notifications list / read / unread`.

Adds three new subcommands and three new envelope schemas:
- `freelo.notifications.list/v1`
- `freelo.notifications.read/v1`
- `freelo.notifications.unread/v1`

Read supports `--all-unread` to drain the unread feed in one call.
All operations are server-side idempotent. No new dependencies.
```

### Step 10 — Doc autogen

- Run `pnpm fix:readme` (regenerates README from introspection — captures three new subcommands + the new top-level group).

### File touch budget

13 new src files + 4 new test files + 1 changeset + 1 modified (`freelo.ts`) + 1 README diff (auto) = **20 files**. Within budget (25).

### Order of work

1. schemas (no deps)
2. api wrappers (deps: schemas, client.ts, pagination, query)
3. human renderers (deps: schemas types only)
4. shared mark.ts (deps: api + renderers + schemas + batch + handle)
5. leaf re-exports (read.ts, unread.ts) + list.ts
6. parent registrar
7. wire into bin/freelo.ts
8. typecheck/lint loop (early — catches type errors before tests)
9. tests
10. test loop
11. coverage check
12. doc autogen (`pnpm fix:readme`)
13. changeset
14. local gates on committed tree (`typecheck && lint && test && build && check:readme`)

### No new dependencies. No security review trigger.
