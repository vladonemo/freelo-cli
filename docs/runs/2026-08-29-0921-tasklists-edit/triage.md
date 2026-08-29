# Triage — M02 `freelo tasklists edit <id>`

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 1 (triage)
**Performed by:** orchestrator (inline — see decision 1; `Task` tool disabled this session)

## Verdict

| Field | Value |
|---|---|
| **Risk tier** | **Yellow** (roadmap guess confirmed) |
| **Change type** | `feat` |
| **Branch** | `feat/tasklists-edit` |
| `needsSecurityReview` | **false** |
| `requiresFreeloApi` | true (design-time only — spec is fully documented, no fixture capture, no network) |
| `preApprovedDeps` | `[]` — no new dependencies |

## Tier rationale

Against `autonomous-sdlc.md` §Risk tiers:

**Yellow triggers hit:**
- New user-visible command (`tasklists edit`) and 10 new flags — additive.
- New envelope schema `freelo.tasklists.edit/v1` — brand new, not a change to an existing one.
- Changeset will be `minor`.

**Green ruled out:** "no new user-visible command or flag" fails.

**Red ruled out — checked each trigger:**
- Does not touch `src/config/`, auth flows, `src/api/client.ts`, TLS/retry/redirect defaults. ✅
- No security-auditor Critical (auditor not triggered). ✅
- No breaking change: no flag removed, no exit code changed, no existing envelope schema altered. ✅
- No dependency removal or major bump. ✅
- Changeset is `minor`, not `major`. ✅
- **Spec has no unresolvable Open questions** — the two design questions (`priorityApplied` shape, `--should-change-existing-tasks` gating) were *explicitly delegated to /spec time by the human in the requirement*, with instructions to "decide deliberately and log". That is a decide-and-log, not a pause. ✅
- **Requirement is not ambiguous about scope or UX** — the CLI shape is given flag-by-flag. ✅

## OpenAPI verification — every roadmap claim re-checked against spec text

Source: `docs/api/freelo-api.yaml`, `operationId: editTasklist` at **line 1251**; block spans **:1235-1305**.

| # | Roadmap claim | Verdict | Spec evidence |
|---|---|---|---|
| 1 | `budget` is a **string of minor currency units**, `"100000"` = 1000.00; decimal strings rejected 400 | **CONFIRMED verbatim** | `budget: {type: string, nullable: true, description: "Integer amount in minor currency units, encoded as a string (e.g. \"100000\" for 1000.00). \`null\` or \`\"0\"\` clears the budget. Decimal strings (\"100.50\") are rejected with HTTP 400."}` |
| 2 | `priority` = **positional reorder within project**, 1 = first, others shift, out-of-range clamps to last; NOT importance | **CONFIRMED verbatim** | `"new position (order) of the tasklist within the project, 1 = first. Other tasklists in the moved-over range shift by ±1 to fill the gap. Values past the end are clamped to the last position. Despite the name, this is positional ordering — not task importance (priority_enum)."` Schema: `priority: {type: integer, minimum: 1}` |
| 3 | `priorityApplied` is a **required boolean** in the 200 response | **CONFIRMED** | `responses.'200'.schema: {type: object, required: [priorityApplied], properties: {priorityApplied: {type: boolean, ...}}}`. Description: *"the priority renumber runs outside the transaction that commits `name`, `budget`, `time_budget_minutes`, `tracking_users_ids` and `worker_id`. A failure of the priority renumber does NOT roll back the other fields… the client may retry the priority update separately."* The 200 body carries **nothing else** — no tasklist entity. |
| 4 | `tracking_users_ids: []` clears all followers; `should_change_existing_tasks: true` propagates to every existing task | **CONFIRMED** + **one addition the roadmap omitted** | `"send [] to clear all followers. IDs of users without access to the tasklist are silently filtered out. Combine with should_change_existing_tasks: true to also propagate the change to every existing task."` — **the silent filtering of inaccessible user ids is not in the roadmap summary** and must be surfaced in help text. Schema: `should_change_existing_tasks: {type: boolean, default: false}` |
| 5 | `worker_id: null` clears the default worker | **CONFIRMED** | `"worker_id: send null to clear the default worker."` Schema: `worker_id: {type: integer, nullable: true, minimum: 1}` |

**No contradiction found between the requirement summary and the OpenAPI spec.** The "Spec says something the OpenAPI spec contradicts → Pause" trigger does **not** fire.

Additional spec facts not in the roadmap summary:
- `time_budget_minutes: {type: integer, nullable: true, minimum: 0}` — **minimum 0, not 1.** `0` is a legal value distinct from `null`. The flag validator must allow `0`.
- `name: {type: string, minLength: 1}` — empty string is a server-side 400; validate client-side.
- Request body is `required: true`; every property is optional. An empty body is legal on the wire but useless — the CLI enforces at-least-one-mutating-flag.
- `tasklist_id` path parameter is a plain `integer` (no `TasklistIdParam` `$ref` here).

## ⚠ Roadmap claim REFUTED — `src/lib/money.ts` does not exist

The roadmap slice says *"Reuse `src/lib/money.ts` (R22) if the encoding matches; verify first"*, and the human's requirement repeated it. **There is no `src/lib/money.ts`.** Full listing of `src/lib/`:

```
batch.ts  confirm.ts  dry-run.ts  env.ts  filename.ts  format.ts  idempotency.ts
input.ts  introspect.ts  iso-timestamp-future.ts  iso-timestamp.ts  label-color.ts
logger.ts  multipart.ts  parse-fields.ts  query.ts  request-id.ts  stdin.ts  version.ts
```

`grep -rn "money|minor currency|minor unit|MinorUnit" src/ -i` returns only four doc-comments on `CurrencySchema` declarations (`src/api/schemas/{project,report,task,tasklist}.ts`) — those are **response-side** schemas that normalize `amount: string|number → string`. They are not a request-side encoder and are not reusable here.

The **actual** in-repo precedent for the request side is `parseBudgetFlag` in `src/commands/tasklists/create.ts:56-65` (R34), which validates `^[0-9]+$` and passes the string through verbatim to avoid float drift. That matches this endpoint's documented encoding exactly. See decision 3 for the reuse-vs-duplicate call.

## Precedent files located (absolute paths)

| Precedent | Path |
|---|---|
| R06 `tasklists show` (same resource) | `C:\Work\Freelance\freelo-cli\src\commands\tasklists\show.ts` |
| R34 `tasklists create` — budget flag parser, dry-run, `rewriteApiHint` | `C:\Work\Freelance\freelo-cli\src\commands\tasklists\create.ts` |
| R34 tasklists API module shape | `C:\Work\Freelance\freelo-cli\src\api\tasklists-create.ts` |
| Tasklist zod schemas | `C:\Work\Freelance\freelo-cli\src\api\schemas\tasklist.ts` |
| R10 `tasks edit` — clear-flags, mutex, `applied_changes`, decision-11 notice | `C:\Work\Freelance\freelo-cli\src\commands\tasks\edit.ts` |
| R13 confirmation helper | `C:\Work\Freelance\freelo-cli\src\lib\confirm.ts` |
| M07 `files delete` — global `--yes` resolution (`resolveYesFlag`) | `C:\Work\Freelance\freelo-cli\src\commands\files\delete.ts:216-225` |
| **Partial-result-then-nonzero precedent** (relevant to decision 4) | `C:\Work\Freelance\freelo-cli\src\commands\comments\list.ts:398-411` |
| Envelope builder | `C:\Work\Freelance\freelo-cli\src\ui\envelope.ts` |
| Command group registration | `C:\Work\Freelance\freelo-cli\src\commands\tasklists.ts` |
| MSW handler conventions | `C:\Work\Freelance\freelo-cli\test\msw\handlers.ts:4008-4075` (`tasklistsCreateHandlers`) |
| Test harness conventions | `C:\Work\Freelance\freelo-cli\test\commands\tasklists\create.test.ts` |

Confirmed present: `src/lib/confirm.ts` ✅. Confirmed absent: `src/lib/money.ts` ❌.

## Design questions carried into /spec (all decidable autonomously)

| # | Question | Autonomous? | Why |
|---|---|---|---|
| A | `priorityApplied: false` → notice on exit 0, or non-zero exit? | **Yes** — human explicitly delegated it in the requirement ("actually decide this at /spec time… pick deliberately"). Two competing in-repo precedents exist (R10 d11 vs. the list-partial pattern); the discriminator is derivable. | → decision 4 |
| B | Does `--should-change-existing-tasks` warrant R13 `--yes` gating? | **Yes** — human explicitly delegated. `confirmDestructive` is a drop-in and the blast-radius argument is decidable on the spec text. | → decision 5 |
| C | Reuse vs. duplicate the budget parser, given `src/lib/money.ts` is absent | **Yes** — repo has an explicit, repeated convention here (M07 d4 "uuid parser kept local"; two in-code "deferred to a follow-up refactor" comments). | → decision 3 |
| D | Does the command need a post-edit refresh GET (R10 d11 shape)? | **Yes** — derivable from the response schema (carries no entity) and `TasklistDetail`'s field set. | → decision 6 |
| E | `--tracking-users` variadic (`<id>...`) vs. repeatable | **Yes** — small UX choice with clear codebase precedent (`collectPositiveInt`). | → decision 7 |
| F | Wire value for `--clear-budget`: `null` or `"0"` (spec permits both) | **Yes** — internal wire choice. | → decision 8 |

**No pause candidates.** Nothing requires a human before implementation starts.

## Blockers

None.
