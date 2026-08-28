# Triage — 2026-08-25-0909-tasks-list-order-by-due-date

**Tier:** Yellow
**Commit type:** feat

## Summary

`freelo tasks list --order-by` accepts four values (`priority`, `name`, `date_add`, `date_edited_at`).
The refreshed cached OpenAPI contract (PR #112) now documents a fifth, `due_date`, on the task-listing
routes. Widen the CLI's client-side enum — and the TypeScript unions that mirror it — so the value can
reach the wire instead of being rejected at parse time with exit 2.

## Scope verification (requirement step 1 — verified, not assumed)

Direct read of `docs/api/freelo-api.yaml`:

| Path | Path line | `order_by` line | Enum | Default |
|---|---|---|---|---|
| `/project/{project_id}/tasklist/{tasklist_id}/tasks` | 1498 | 1522 | `[priority, name, date_add, date_edited_at, due_date]` | `priority` |
| `/all-tasks` | 1581 | 1639 | `[priority, name, date_add, date_edited_at, due_date]` | `date_add` |

**Both routes carry `due_date`.** The roadmap's open question ("confirm whether `/all-tasks`'s
`order_by` enum also gained `due_date` before scoping this") resolves to **yes**. `/all-tasks` also
carries the same upstream behavior note plus an extra sentence the tasklist route does not have:

> When `due_date`, tasks without a due date are always last; all-day tasks sort at the start of their
> day (00:00). Results are tie-broken by task id for stable pagination.

Scope is therefore **both** code paths. Every other `order_by` enum in the file
(lines 208, 298, 458, 544, 1342, 3270 — projects, tasklists, files, comments, etc.) is unrelated and
stays untouched.

## Signals

- [x] Touches `src/commands/` (changed subcommand — flag validation widened, help text changed)
- [ ] Touches `src/config/`
- [ ] Touches `src/api/client.ts` or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [ ] Changes an envelope schema (`freelo.*/vN`) — see reasoning below
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API (existing endpoints only; no new call sites)
- [ ] Docs-only

## Route flags

- requiresFreeloApi: true (contract-read only — `allowNetwork: false`, MSW for tests)
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale — why Yellow and not Green

All six Green preconditions in `autonomous-sdlc.md` §Green hold on their face (no auth/config/client/
release-tooling changes, no new deps, no breaking change to envelope schema, exit codes, or flag
names). The roadmap slice's own read was "Green candidate." I am nonetheless calling **Yellow**, on
two independent triggers:

1. **"New user-visible command or flag (additive)."** This is not literally a new flag, but it is
   additive growth of the public CLI surface: `--order-by`'s help string changes, and
   `freelo --introspect` — a declared public contract in `CLAUDE.md` — emits that string. A user can
   now do something that previously exited 2. The spirit of the trigger (the surface grew; a human
   should eyeball it) fires even though the letter ("new flag") does not.
2. **"Changeset is `minor`."** Under SemVer this is new backwards-compatible functionality, so
   `minor`, and repo precedent is unambiguous: every "users can now do X" entry in `CHANGELOG.md` is
   a Minor Change, including the closest analogue in size — `0.13.0`, "Add `--palette <name>` flag on
   three label-write commands (R24.5)."

Considered and rejected: framing this as a `fix` + `patch` ("the CLI's whitelist drifted from the API
contract; resync it"). That framing is wrong on the facts — the four-value enum was *correct* until
PR #112 landed the refreshed spec. The capability is newly available upstream, not previously broken
downstream. `feat` + `minor` it is.

Per §Risk tiers, highest tier wins when signals conflict. Yellow flow: full pipeline → open PR →
**no auto-merge**; a human reviews and merges.

## Not an envelope change

`AppliedFilters.order_by` (`src/api/schemas/task.ts:149`) is a TypeScript union that widens from four
string literals to five. This is **not** a `freelo.tasks.list/v1` → `/v2` event: no field is added,
removed, renamed, or retyped, and `applied_filters` echoes only user-supplied flags. A consumer can
only ever observe `order_by: "due_date"` in a payload if that consumer itself passed
`--order-by due_date`. No existing caller's output changes by one byte. Same reasoning the #108
changeset used to justify no bump. The changeset should still state this explicitly.

## Open concerns for the architect

1. **Wire-default interaction on the tasklist route (#108 / spec 0060).** `getTasklistActiveTasks`
   sends `order_by=priority&order=asc` only when the caller supplies *neither* flag. `--order-by
   due_date` alone must therefore send `order_by=due_date` and **no** `order` param. Confirm the
   existing branch already does this (it should — the value is opaque to that branch) and pin it with
   a test rather than assuming.
2. **Two enums, one literal list, three files.** `src/commands/tasks/list.ts:63,280`,
   `src/api/tasks.ts:51,126`, `src/api/schemas/task.ts:149`. Decide whether to introduce a single
   shared `const` and re-derive the unions, or repeat the widening in all five places. Prefer whatever
   matches house style (`src/commands/comments/list.ts:59` uses a local `ORDER_BY_VALUES` const).
3. **Help-text string** at `src/commands/tasks/list.ts:276` must be widened too, or `--help` lies.
   `README.md` does not enumerate options, so `pnpm check:readme` is likely unaffected — verify by
   running it, do not assume.
4. **Docs.** `docs/commands/tasks-list.md` §Ordering (lines 67–98) needs the new value plus the
   null-last / all-day-at-00:00 / tie-broken-by-id semantics, for **both** routes.

## Recommended branch name

`feat/tasks-list-order-by-due-date`

---

```
TRIAGE run=2026-08-25-0909-tasks-list-order-by-due-date tier=Yellow type=feat flags=[requiresFreeloApi] bump=minor bothRoutes=true
```
