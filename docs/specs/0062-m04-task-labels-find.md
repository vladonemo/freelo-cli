# 0062 — `freelo task-labels find` (M04)

**Status:** Specified
**Run:** 2026-08-25-1037-task-labels-find
**Roadmap:** `docs/roadmap-migration-2026-08.md` § M04
**Type:** feat
**Changeset:** `minor`
**Risk tier:** Yellow (PR stops for human review — no auto-merge)

---

## 1. Problem

There is no way to list task labels from the CLI. `freelo task-labels` ships three leaves today —
`create`, `attach`, `detach` (R24, spec 0036) — and all three are **write** operations that take a
label by `--name` or `--uuid`. Nothing reads.

That leaves a user (or an agent) who wants to attach an *existing* label by uuid with no way to
discover the uuid. `.claude/skills/freelo-api/SKILL.md` has carried this in Known quirks since R24:

> there is no documented bulk-list endpoint for task-labels... to resolve a task-label name to its
> uuid, either (a) scan tasks via `GET /all-tasks` (expensive) or (b) round-trip via
> `POST /task-labels/add-to-task`.

Both workarounds are bad. (a) is O(all tasks) for a lookup that should be one GET. (b) mutates a
task just to learn an identifier.

The API gained a proper endpoint. `GET /task-labels/find-available` is newly documented in the
refreshed `docs/api/freelo-api.yaml` (PR #112). This spec wires it up.

## 2. Proposal — CLI surface

```
freelo task-labels find [--project <id>]
```

A new **read-only** leaf on the existing `task-labels` parent. No writes, no `--dry-run` (nothing to
preview — there is no mutation), no confirmation gate.

| Flag | Type | Required | Meaning |
|---|---|---|---|
| `--project <id>` | positive integer | no | Restrict results to labels used in this one project. Omitted → every label usable by the caller. |

### Examples

```bash
# Every task label the caller can use, sorted by name.
freelo task-labels find

# Only labels actually used in project 42.
freelo task-labels find --project 42

# Resolve a name to a uuid, then attach it — the workflow this unblocks.
UUID=$(freelo task-labels find --output json | jq -r '.data.labels[] | select(.name=="Bug") | .uuid')
freelo task-labels attach --task 12345 --uuid "$UUID"
```

### Human output

`cli-table3` table, columns `UUID | NAME | COLOR`. Empty result renders the standard
`(no task labels)` placeholder row, mirroring `freelo labels list`
(`src/ui/human/labels-list.ts:22-26`).

## 3. API surface

**`GET /task-labels/find-available`** — `docs/api/freelo-api.yaml:2841-2876`, operationId
`findAvailableTaskLabels`.

Verbatim from the cached contract:

> Returns all task labels usable by the authenticated user — labels attached to tasks across the
> caller's owned and invited projects in `ACTIVE`, `ARCHIVED`, or `TEMPLATE` state.
>
> **Behavior notes:**
> - Sorted by `name` ascending.
> - Pass the optional `project_id` query parameter to restrict the result to labels used in that
>   single project. The project must be one the caller owns or is invited to; otherwise
>   `{ "labels": [] }` is returned.
> - If the caller has no accessible projects, returns `{ "labels": [] }`.

Query parameter (yaml:2858-2864): `project_id`, `in: query`, `required: false`,
`schema: { type: integer }`.

Response 200 (yaml:2865-2876): `{ labels: TaskLabel[] }`.

### 3.1 This is NOT `/project-labels/find-available`

Load-bearing distinction, and the single easiest mistake to make in this slice:

| | `/project-labels/find-available` (R23, spec 0035) | `/task-labels/find-available` (**this spec**) |
|---|---|---|
| Concept | Project-level labels | Task-level labels |
| CLI | `freelo labels list` | `freelo task-labels find` |
| Item schema | `ProjectLabel` — **`id`** (int), name, color, is_private, usage_count, … | `TaskLabel` — **`uuid`** (string), name, color |
| Key | numeric `id` | string `uuid` |
| `project_id` query param | **not accepted** — flag deferred, spec 0035 decision 03 | **accepted** — flag ships in v1 |

SKILL.md's existing Known-quirks note that "`find-available` returns empty results" is about the
**project-labels** endpoint. It does not transfer to this one and must not be conflated when
SKILL.md is updated in the document phase.

### 3.2 The `id` field the requirement mentions does not exist

The roadmap slice and the run requirement both describe the output as "id/uuid/name/color". The
authoritative `TaskLabel` schema (`docs/api/freelo-api.yaml:5949-5958`) is:

```yaml
TaskLabel:
  type: object
  properties:
    uuid:   { type: string, format: uuid }
    name:   { type: string }
    color:  { type: string }
```

**There is no `id`.** Task labels are uuid-keyed; the id-keyed labels are project-labels. The
OpenAPI contract is authoritative (`autonomous-sdlc.md` §Failure modes). The command exposes
`uuid`, `name`, `color` and no `id` column. → **Decision 02.**

The response schema is still `.passthrough()` and every leaf is `.nullable().optional()` per the
project's permissive-schema policy, so if the live API *does* return an extra `id`, it survives into
`--output json` untouched — it just isn't a documented column.

## 4. Data model

New in `src/api/schemas/task-label.ts` (extending the existing R24 file):

```ts
/** `TaskLabel` wire shape (OpenAPI :5949-5958). uuid-keyed, unlike ProjectLabel. */
export const TaskLabelSchema = z
  .object({
    uuid: z.string().nullable().optional(),
    name: z.string().nullable().optional(),
    color: z.string().nullable().optional(),
  })
  .passthrough();

/** Response body of `GET /task-labels/find-available`. */
export const FindAvailableTaskLabelsResponseSchema = z
  .object({ labels: z.array(TaskLabelSchema) })
  .passthrough();

/** Live `data` shape for `freelo.task_labels.find/v1`. */
export const TaskLabelsFindDataSchema = z.object({
  labels: z.array(TaskLabelSchema),
  count: z.number().int().min(0),
  project_id: z.number().int().optional(),
});
```

Note `labels` itself is **required** on the response schema (not optional) — a body without it is a
contract violation and should fail validation loudly, exactly as `FindAvailableLabelsResponseSchema`
does for project-labels. An *empty* `labels` array is valid and expected; a *missing* `labels` key
is not.

### 4.1 Envelope

New schema string: **`freelo.task_labels.find/v1`**. Additive — no existing envelope schema is
touched, so no `/v2` bump anywhere.

```json
{
  "schema": "freelo.task_labels.find/v1",
  "data": {
    "labels": [
      { "uuid": "0f8b...", "name": "Bug", "color": "#d64541" },
      { "uuid": "3a1c...", "name": "Chore", "color": "#77787a" }
    ],
    "count": 2,
    "project_id": 42
  },
  "rate_limit": { "remaining": 4998, "reset_at": "..." }
}
```

`count` mirrors the `count` field the three existing `task_labels.*` envelopes already carry
(`TaskLabelsCreateData`, `TaskLabelsAttachData`, `TaskLabelsDetachData`) — consistency within the
resource group. → **Decision 03.**

`project_id` is present only when `--project` was passed, so a consumer can tell a
scoped-and-empty result from an unscoped-and-empty one without re-reading argv. → **Decision 03.**

No `paging` — the endpoint documents no pagination parameters and returns a single-shot array,
same as `freelo labels list`.

## 5. Edge cases

| Case | Wire | CLI behavior | Exit |
|---|---|---|---|
| Labels found | 200 `{labels:[...]}` | table / JSON envelope | 0 |
| `--project` names a project the caller can't access | 200 `{labels:[]}` | **empty list, success** | **0** |
| `--project` names a nonexistent project | 200 `{labels:[]}` | **empty list, success** | **0** |
| Caller has no accessible projects at all | 200 `{labels:[]}` | **empty list, success** | **0** |
| `--project` not a positive integer | — (never sent) | `ValidationError` | 2 |
| Response body missing `labels` | 200 malformed | `FreeloApiError` `VALIDATION_ERROR` | **4** |
| 401 | 401 | `FreeloApiError` | 3 |
| 5xx | 500 | `FreeloApiError` | 4 |
| Network failure | — | `NetworkError` | 5 |
| 429 | 429 | `RateLimitedError` | 6 |

The malformed-body row deserves a note: schema-validation failure on a *response* surfaces as
`FreeloApiError` with `code: VALIDATION_ERROR` and **exit 4**, not the exit 2 that a bad *input*
gets. That's the established behavior of `src/api/client.ts` and is asserted the same way in
`test/commands/labels/list.test.ts:234-242`. Exit 2 is reserved for input the user controls; a
server sending a body we can't parse is a server-side fault. → **Decision 07.**

**The three empty-result rows are the crux of this slice.** The API deliberately does not
distinguish "no such project", "you can't see that project", and "that project has no labels" — all
three are 200 `{ "labels": [] }`. The CLI must **not** synthesise a 404, must **not** throw, and
must **not** exit non-zero. An empty list is a legitimate answer. → **Decision 04**, and it gets
dedicated test coverage on both documented arms (§7).

This is also a deliberate non-feature: we cannot tell the user *why* the list is empty, because the
API doesn't tell us. Help text says so rather than guessing.

## 6. Non-goals

- **No `--name` / `--uuid` client-side filter.** `--output json | jq` covers it, and the endpoint
  offers no server-side name filter. Adding client-side filtering invites a "why is `--name Bug`
  case-sensitive?" question this slice doesn't need to answer.
- **No rewiring of `task-labels attach --name`.** The roadmap explicitly defers this ("Follow-up,
  not part of this slice"). Checked: `attach` sends name-mode entries straight to
  `POST /task-labels/add-to-task/{task_id}` and lets the server fetch-or-create
  (`src/commands/task-labels/attach.ts`, `buildAddTaskLabelsBody`). It performs **no** uuid
  round-trip workaround, so there is nothing to un-hack. No change. → **Decision 05.**
- **No `--project` repeatable / multi-project form.** The endpoint takes a single scalar
  `project_id`.
- **No caching / TTL.** One GET per invocation.
- **Not M05 (`task-labels colors`) or M06 (`task-labels merge`).** Separate roadmap slices.

## 7. Test strategy

Integration tests through the real Commander tree with MSW, mirroring
`test/commands/labels/list.test.ts`.

Per calibration §2, **every** typed error class the spec assigns an exit code gets an assertion:
`ValidationError` (2, both the flag-parse arm and the schema arm), `FreeloApiError` (3 and 4),
`NetworkError` (5), `RateLimitedError` (6).

1. Happy path, multiple labels → envelope `schema`, `data.labels`, `data.count`.
2. **Empty result, unscoped** (caller has no accessible projects) → exit **0**, `labels: []`,
   `count: 0`.
3. **Empty result, scoped** (`--project` inaccessible) → exit **0**, `labels: []`, `count: 0`,
   `project_id` echoed.
4. `--project 42` → asserts the outbound request carries `?project_id=42`.
5. No `--project` → asserts the outbound path carries **no** query string at all.
6. `--output human` → table renders, includes a label name.
7. `--output human` on an empty result → `(no task labels)` placeholder.
8. `--project abc` and `--project 0` → `ValidationError`, exit 2, request never sent.
9. Malformed body (`labels` key missing) → exit 2.
10. 401 → 3; 500 → 4; network error → 5; 429 → 6.
11. `--introspect` lists `task-labels find` with `output_schema: freelo.task_labels.find/v1` and
    `destructive: false`.

No TTY-prompt path in this command, so calibration §7 (`CI` env clearing) does not apply — there is
no `isInteractive()` gate to cross. The `--output human` tests drive the renderer directly through
the `--output human` flag, not through TTY detection.

## 8. Open questions

None. The endpoint is fully documented in the cached contract, the CLI shape is fixed by the
roadmap, and the field-list discrepancy in §3.2 is resolved by the OpenAPI contract being
authoritative. Nothing requires a human decision.

---

## Plan

**No new dependencies.** Everything needed already exists: `buildQuery` (`src/lib/query.ts`) for the
one query param, `renderTable` for the human path, the R24 `task-label.ts` schema file to extend.

### Files

| File | Action | Intent |
|---|---|---|
| `src/api/schemas/task-label.ts` | modify | Add `TaskLabelSchema`, `FindAvailableTaskLabelsResponseSchema`, `TaskLabelsFindDataSchema` + inferred types. Append below the existing detach block; touch nothing already there. |
| `src/api/task-labels.ts` | modify | Add `FIND_AVAILABLE_TASK_LABELS_PATH`, `findAvailableTaskLabelsPath(projectId?)` (composes `?project_id=` via `buildQuery`), and `findAvailableTaskLabels(client, opts)`. First `GET` in this module — update the module docblock's endpoint list. |
| `src/commands/task-labels/find.ts` | **create** | The leaf. `registerFind(parent, getConfig, env)`, `meta` with `outputSchema: 'freelo.task_labels.find/v1'`, `destructive: false`. `parseProjectIdFlag` throws `ValidationError` on non-positive-integer. Modelled on `src/commands/labels/list.ts` for the read-only flow and on `attach.ts` for the flag parser shape. |
| `src/commands/task-labels.ts` | modify | `registerFind(taskLabels, getConfig, env)` + import. Update the docblock's "Three leaves" → four. |
| `src/ui/human/task-labels-find.ts` | **create** | `renderTaskLabelsFindHuman(data)`, async (lazy `cli-table3` via `renderTable`). Columns `UUID | NAME | COLOR`; `(no task labels)` placeholder on empty. |
| `test/msw/handlers.ts` | modify | New `taskLabelsFindHandlers` block: `findAvailableOk(labels)`, `findAvailableOkCapturing(capture)` (records the request URL for the query-param assertions), `findAvailableMalformed()`, `findAvailableUnauthorized()`, `findAvailableServerError(status)`, `findAvailableRateLimited()`, `findAvailableNetworkError()`. |
| `test/commands/task-labels/find.test.ts` | **create** | The 11 cases in §7. |
| `docs/commands/task-labels-find.md` | **create** | User doc — synopsis, options, the empty-result semantics, envelope sample, two+ realistic examples including the name→uuid resolve-then-attach workflow. |
| `README.md` | modify | Autogen Commands block via `pnpm fix:readme`. Never hand-edited. |
| `.changeset/*.md` | **create** | `minor`, with an explicit line naming the new envelope schema per `CLAUDE.md`. |
| `.claude/skills/freelo-api/SKILL.md` | modify | Retire the "no bulk-list for task-labels" half of the Known-quirks entry at :179-187; keep the project-labels half intact and correct (see §3.1). |

11 files (10 + the run/decision artifacts) — within the 25-file budget.

### Order

1. Schemas → 2. API wrapper → 3. Renderer → 4. Command leaf → 5. Parent registration →
6. `pnpm lint && pnpm typecheck` → 7. MSW handlers → 8. Tests → 9. `pnpm test:cov` →
10. Docs + `pnpm fix:readme` + changeset + SKILL.md → 11. commit → 12. **full gate on the committed
tree** (calibration §3) → 13. push + PR.

Single landable slice; no sub-slicing needed.

### Test strategy

All integration, through the real Commander tree with MSW — matching
`test/commands/labels/list.test.ts`. No unit-only tests: the renderer and the query composer are
both exercised end-to-end, and neither has branching complex enough to warrant a separate harness.

Coverage targets: `src/api/` and `src/commands/` ≥ 90%. The new leaf has exactly four branches
(`--project` present/absent × request succeeds/throws) plus the parser's two reject arms; §7 cases
4, 5, 8 and 10 cover all of them. Per calibration §4, the diff adds exactly **one** new `catch (`
arm (the leaf's `handleTopLevelError` wrapper) and §7 cases 9-10 drive it four separate ways.

### Risks

- **Wrong sibling endpoint.** Mitigated by §3.1's table and by test case 4/5 asserting the literal
  outbound path `/task-labels/find-available`, which would fail loudly if `/project-labels/…` were
  wired by mistake.
- **Empty-result regression.** The three 200-empty arms are the behavior most likely to be
  "helpfully" turned into an error by a later refactor. Cases 2, 3, 7 lock exit 0 in.
