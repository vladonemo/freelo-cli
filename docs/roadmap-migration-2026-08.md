# Freelo CLI — API migration roadmap (2026-08 refresh)

> Source of truth: `docs/api/freelo-api.yaml`, refreshed 2026-08-24 from `https://api.freelo.io/docs/v1/freelo-api.yaml`.
> Prior cache was last touched 2026-07-27. Diff: **90 → 97 operations, +1145/-110 lines.** `info.version` in the upstream doc is a hardcoded `"1.0.0"` — Freelo does not semver this spec, so it is not a usable freshness signal; the endpoint/line delta is.
>
> This doc is a **delta roadmap**, sibling to `docs/roadmap.md`, not a replacement for it. It only covers what changed in this refresh: newly-documented endpoints, and existing roadmap items this refresh unblocks or extends. Everything in `docs/roadmap.md` that isn't mentioned here is unaffected. Same slicing principles and per-slice contract apply (see `docs/roadmap.md` §Slicing principles) — read that doc first if the format here is unfamiliar.

## What actually changed

Nine new operations (`operationId` diff), zero removed:

| operationId               | Method + path                             | New / unblocks                                                                                                    |
| ------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `editTasklist`            | `POST /tasklist/{tasklist_id}/edit`       | New — no `tasklists edit` command exists today                                                                    |
| `editTaskcheck`           | `POST /taskcheck/{taskcheck_id}`          | New resource — simple checklist items                                                                             |
| `deleteTaskcheck`         | `DELETE /taskcheck/{taskcheck_id}`        | New resource                                                                                                      |
| `finishTaskcheck`         | `POST /taskcheck/{taskcheck_id}/finish`   | New resource                                                                                                      |
| `activateTaskcheck`       | `POST /taskcheck/{taskcheck_id}/activate` | New resource                                                                                                      |
| `findAvailableTaskLabels` | `GET /task-labels/find-available`         | **Unblocks a documented quirk** — SKILL.md previously said no bulk-list/resolver endpoint existed for task-labels |
| `getTaskLabelColors`      | `GET /task-label-colors`                  | New — server-side palette, currently hardcoded client-side in R24.5                                               |
| `mergeTaskLabels`         | `POST /task-labels/merge`                 | New                                                                                                               |
| `deleteComment`           | `DELETE /comment/{comment_id}`            | **Unblocks R18.5** (`freelo comments delete`), queued since 2026-04-28                                            |
| `deleteDocOrFileByUuid`   | `DELETE /file/{file_uuid}`                | New — extends Wave 4 files surface (R25–R27, read/upload only until now)                                          |

Plus one **additive enum value**, no new operation: `order_by` on `GET /project/{project_id}/tasklist/{tasklist_id}/tasks` (the endpoint R07 already covers, and the one `freelo-cli@0.20.2` just patched for #108) gained `due_date` alongside the existing `priority | name | date_add | date_edited_at`. Upstream also added a `description` to that parameter documenting `due_date`'s null-last / all-day tie-break rule — merged into the cache alongside our own live-verified note on what `priority` means (`docs/decisions/2026-08-24-1759-fix-tasklist-task-order-5-yaml-annotate-not-correct.md`).

**Two pre-existing local corrections were re-verified and re-applied on top of the refresh** (the raw upstream file still has the old, wrong versions — this is not new information, just confirmed still-true):

- `POST /notification/{id}/mark-read` / `/mark-unread` — upstream still documents the `-as-` infix form, which is live-verified non-functional. `WIRE QUIRK` annotations restored, dated against both the original 2026-04-29 finding and this refresh.
- `only_unread` on `GET /all-notifications` — upstream now _independently_ documents that the wire value must be `0`/`1`, not `true`/`false`. This one caught up; no local override needed anymore, and SKILL.md's "Known quirks" note can be marked resolved.

No `operationId` was removed and no response/request schema on an _existing, already-implemented_ endpoint changed shape in a way that would break current CLI code — this refresh is purely additive from the CLI's point of view. (Standard caveat: field-level diffing of all 97 endpoints' schemas is out of scope for a roadmap pass; each slice below re-verifies its own endpoint against the live API during `/spec`, same as every other roadmap slice always has.)

## Wave overview

| Wave | Theme                                    | Slices  | Depends on                       |
| ---- | ---------------------------------------- | ------- | -------------------------------- |
| M1   | Unblock a queued slice                   | M01     | R18                              |
| M2   | Tasklist admin gains an edit surface     | M02     | R06, R13                         |
| M3   | Task checklist items (new resource)      | M03     | R14                              |
| M4   | Task-label tooling catches up to the API | M04–M06 | R24, R24.5                       |
| M5   | Files gains a delete verb                | M07     | R25–R27, R13                     |
| M6   | `tasks list` ordering, extended          | M08     | R07 (already shipped — additive) |

Dependency rule is the same as `docs/roadmap.md`: a slice may only depend on earlier-numbered slices (from either doc). `M`-prefixed slices are independent of each other except where a dependency is stated; pick them up in any order once their listed dependency is shipped.

---

## M01 — `freelo comments delete <id>` (unblocks R18.5) ✅ shipped

**Status:** **Shipped** — [spec 0061](specs/0061-m01-comments-delete.md), run `2026-08-25-0813-comments-delete`. `docs/roadmap.md` §R18.5 updated to shipped.

**Design note worth carrying forward:** the 404 was **not** treated as an idempotent already-deleted success, unlike every other delete in the CLI. Because the ACL-hides-existence pattern makes 404 mean _either_ "gone" _or_ "not yours", absorbing it would report success for a comment still in the thread. M04 (`task-labels merge`) and M07 (`files delete`) hit the same 404-ACL pattern — re-read spec 0061 §5.1 and decision `2026-08-25-0813-comments-delete-1` before deciding their idempotency policy, and note that the answer may legitimately differ per resource depending on whether 404 is ambiguous there.

**Outcome:** R18.5 is no longer blocked. `docs/roadmap.md` §R18.5 can be updated from "Blocked on Freelo API confirmation" to shipped once this lands; no further probing needed, the endpoint is now documented.
**Endpoints:** `DELETE /comment/{comment_id}`.
**Behavior notes (from the spec, load-bearing for the design):**

- ACL: only the comment's author can delete. Non-owner attempts get `404`, not `403` — deliberately, so existence of an inaccessible comment isn't leaked. Surface this as a plain "not found" error, not a permission error.
- **15-minute deletion window** from post time. After that, `400`. This needs a clear, specific error message (not a generic 400 passthrough) — a user or agent hitting this needs to know _why_ immediately, not "bad request."
  **CLI:** `freelo comments delete <id>... [--yes] [--dry-run]` / `--ids` / `--stdin` — same shape R18.5 already specified.
  **Ships with this slice:** reuses `src/lib/confirm.ts` (R13) and `src/lib/batch.ts` (R09). No new infra.
  **Depends on:** R18 (comments edit — sibling command, same resource), R13 (confirm), R09 (batch).
  **Tier:** Yellow (new destructive command, additive, no schema/auth changes).

---

## M02 — `freelo tasklists edit <id>`

**Outcome:** First write command on tasklists other than create. Rename a tasklist, adjust its budget / time fund, manage followers and default worker, and reorder tasklists within a project — all from the terminal.
**Endpoints:** `POST /tasklist/{tasklist_id}/edit`.
**CLI:**

```
freelo tasklists edit <id> [--name <str>] [--budget <amount>|--clear-budget]
                           [--time-budget-minutes <n>|--clear-time-budget]
                           [--worker <id>|--clear-worker]
                           [--tracking-users <id>...|--clear-tracking-users]
                           [--should-change-existing-tasks]
                           [--priority <n>] [--dry-run]
```

**Behavior notes (load-bearing — read before speccing):**

- `budget` is a **string of minor currency units** ("100000" = 1000.00), not a decimal string — decimal strings are rejected with 400. Reuse `src/lib/money.ts` (R22) if the encoding matches; verify first, this money format note is a recurring source of bugs in this codebase (see R05.5 bug #2, SKILL.md §Currency encoding).
- `priority` **repositions the tasklist within its project** (1 = first; other tasklists shift to fill the gap; out-of-range values clamp to last). This is the **third** occurrence of the "`priority` field means position, not importance" naming trap in this API — after task `order_by=priority` (#108, now understood) and the existing `priority_enum` (l/m/h) field. Name the flag `--priority` to match the wire field, but the help text and any error messages must be explicit that this is _ordering_, not task-priority-style importance — a user who's seen `priority_enum` elsewhere will reasonably guess wrong.
- **`priority` is applied outside the transaction that commits the other fields.** The response has a required `priorityApplied: boolean` — `false` means everything else succeeded but the reorder didn't, and the caller may retry the priority change alone. This is a **partial-success shape the CLI hasn't handled before** — every prior write command in this codebase is all-or-nothing from the caller's perspective. Design decision needed at `/spec` time: does a `false` `priorityApplied` surface as a `notice` on an otherwise-success envelope (mirroring the refresh-GET-failed pattern from R10 decision 11), or does the whole command fail non-zero? Recommend the `notice` pattern for consistency, but flag it as an open question rather than deciding here — this doc is roadmap-level, not spec-level.
- `tracking_users_ids: []` clears all followers; `should_change_existing_tasks: true` propagates the follower change to every existing task in the tasklist — a potentially wide-blast-radius flag, worth a distinct `--should-change-existing-tasks` opt-in rather than defaulting it on.
- `worker_id: null` clears the default worker.
  **Depends on:** R06 (tasklists show, same resource), R13 (confirm — not strictly destructive, but the wide-blast-radius `should_change_existing_tasks` flag warrants the same `--yes`-gating pattern used for scary writes).
  **Tier:** Yellow (new write command, additive; the partial-success `priorityApplied` shape is worth flagging to a human at spec time even though it's not itself a breaking change).

---

## M03 — `freelo taskchecks` (simple checklist items) ✅ shipped

**Status:** **Shipped** — [spec 0066](specs/0066-m03-taskchecks.md), run `2026-08-29-1046-m03-taskchecks`. Envelopes `freelo.taskchecks.{edit,delete,finish,reopen}/v1`. Tier came back **Yellow**, confirming this slice's guess.

**Three corrections to the analysis below, all found by reading the OpenAPI contract rather than this document:**

1. **`notify_author` is NOT accepted by all four endpoints.** `deleteTaskcheck` (yaml :2156-2171) and `activateTaskcheck` (:2206-2222) declare **no `requestBody` at all**; only `editTaskcheck` and `finishTaskcheck` do. The shipped CLI exposes `--notify-author` on `edit` and `finish` only. The "same shape across all four" claim in the bullet below is wrong — do not propagate it.
2. **The id-space question was decided (a), and the correctness argument is stronger than framed below.** The two id sequences are independent and overlap in range, so auto-probing wouldn't merely "mask a wrong-id mistake" — it would perform a destructive write on a _different, valid, unrelated_ object. See spec 0066 §3.3.
3. **R11's idempotency pattern does not transfer, for a structural reason.** There is no `GET /taskcheck/{id}`, so a checklist item's prior state is unobservable and `already_in_target_state` is omitted from all three transition/delete envelopes rather than hardcoded to `false`. Spec 0066 §5.2.

**Follow-up left open (not in M03's scope):** `Subtask.type` (`subtask` | `taskcheck`) was added to the OpenAPI `Subtask` schema in this doc's own PR #112 refresh (yaml :6380-6386), but `SubtaskSchema` in `src/api/schemas/task.ts:438` still doesn't declare it. It currently reaches `freelo.subtasks.list/v1` output only via `.passthrough()`. Declaring it — and retiring the now-superseded `inferStorageForm` heuristic at `src/api/subtasks.ts:100-133` — is a worthwhile R14 change with its own envelope-schema callout.

**Outcome:** Edit, delete, finish, and reopen simple checklist items — the lightweight `tasks_checks` rows that exist as a fallback when a tasklist can't host smart subtasks (R14 already documents that `POST /task/{id}/subtasks` auto-falls-back to these). Until now there was no way to _manage_ a simple checklist item once created; R14 only covered listing and adding smart subtasks.
**Endpoints:** `POST /taskcheck/{id}` (edit), `DELETE /taskcheck/{id}`, `POST /taskcheck/{id}/finish`, `POST /taskcheck/{id}/activate`.
**Behavior notes (load-bearing):**

- **Two distinct id spaces exist and the API enforces the split at the HTTP level.** A _smart_ taskcheck (one with its own `tasks.id`) returns **404** on all four of these endpoints — smart ones are edited/deleted/finished via the existing `POST /task/{id}` / `DELETE /task/{id}` / `POST /task/{id}/finish` / `POST /task/{id}/activate` paths (already covered by R10/R11/R13). A _simple_ taskcheck only exists as a `tasks_checks` row and only responds on the `/taskcheck/{id}...` paths. The CLI needs to either (a) let the user pick the right command based on which kind of id they have, documenting the distinction clearly in help text, or (b) probe automatically (try `/taskcheck/{id}` first, fall back to `/task/{id}` on 404) and hide the distinction. Recommend (a) for v1 — auto-probing hides a real API distinction and could mask a genuine "wrong id" mistake as a silent success. Revisit at `/spec` time.
- Edit only accepts `name` and `worker` on a simple taskcheck — `priority_enum`, `priority`, `due_date`, `due_date_end` return 400. This is a materially smaller edit surface than `tasks edit` (R10); don't reuse R10's full flag set, only expose `--name` and `--worker`.
- All four endpoints accept an optional `notify_author: boolean` (default false) — "keep the caller in notification recipients even though they triggered the action." Same shape across all four; worth a shared `--notify-author` flag.
- Delete is a soft-delete (matches every other delete in this API).
  **CLI:**

```
freelo taskchecks edit <id> [--name <str>] [--worker <id>|--clear-worker] [--notify-author] [--dry-run]
freelo taskchecks delete <id>... [--yes] [--notify-author] [--dry-run]
freelo taskchecks finish <id>... [--notify-author] [--dry-run]
freelo taskchecks reopen <id>... [--notify-author] [--dry-run]
```

**Depends on:** R14 (subtasks — this is the sibling resource R14's own note already flagged as existing but unmanaged), R13 (confirm/delete pattern), R11 (finish/reopen + idempotency pattern).
**Tier:** Yellow (new resource, additive, no auth/schema-contract changes to existing commands).

---

## M04 — `freelo task-labels find` (name → uuid resolver) ✅ shipped

**Status:** **Shipped** — [spec 0062](specs/0062-m04-task-labels-find.md), run `2026-08-25-1037-task-labels-find`. Envelope `freelo.task_labels.find/v1`. `.claude/skills/freelo-api/SKILL.md`'s "no bulk-list for task-labels" quirk is retired; the two round-trip workarounds it documented are now obsolete.

**Tier came back Yellow, not the Green this slice guessed** — new user-visible command + new flag + new envelope schema + `minor` changeset are each an explicit Yellow trigger, and "highest tier wins". Read-only-ness keeps a slice out of Red; it does not pull it down to Green. M05 below carries the same "Green candidate" guess and should expect the same correction.

**Two notes for M05/M06, which share this resource group:**

- `TaskLabel` has **no `id`** — task labels are uuid-keyed (`docs/api/freelo-api.yaml:5949-5958`). The "id/uuid/name/color" phrasing in the CLI line below is wrong; the OpenAPI contract won. Don't propagate it.
- The `--project`-inaccessible and no-accessible-projects cases both return `{"labels":[]}` / HTTP 200 and are **indistinguishable**. Shipped as exit 0 with an empty list — no synthesised 404. M06's merge, by contrast, gets real 404s for unowned uuids (see M01's note above), so don't copy this empty-is-success policy across without checking the endpoint's actual error model.

**Outcome:** Closes the exact gap SKILL.md's "Known quirks" section has flagged since the original R24 work: _"there is no documented bulk-list endpoint for task-labels... to resolve a task-label name to its uuid, either (a) scan tasks via `GET /all-tasks` (expensive) or (b) round-trip via `POST /task-labels/add-to-task`."_ Neither workaround is needed anymore.
**Endpoints:** `GET /task-labels/find-available` — optionally scoped by `?project_id=`.
**Behavior notes:** sorted by name ascending; returns `{ labels: [] }` (not an error) when the caller has no accessible projects or the given `project_id` isn't accessible — mirror that as an empty result, not an error, in the CLI.
**CLI:** `freelo task-labels find [--project <id>]` — lists all task labels usable by the caller, id/uuid/name/color.
**Follow-up, not part of this slice:** once this ships, `task-labels attach`'s existing `--name` resolution path (R24) can be revisited to use this endpoint instead of its current round-trip-via-add workaround, if one exists — check R24's actual implementation before assuming a change is needed. **Checked during the M04 run: there is no workaround to remove.** `attach` passes name-mode entries straight through to `POST /task-labels/add-to-task/{task_id}` and lets the server fetch-or-create (`buildAddTaskLabelsBody`); it never resolves a uuid client-side. No follow-up change is needed. The one _behavioral_ gap that remains is that `attach --name` will happily create a near-miss duplicate on a typo — `task-labels find` is the mitigation (resolve first, then `attach --uuid`), documented in `docs/commands/task-labels-find.md`, not a code change to `attach`.
**Depends on:** R24.
**Tier:** Green candidate (pure new read command, no existing behavior touched) — confirm at triage.

---

## M05 — `freelo task-labels colors` (server-side palette)

**Outcome:** Replaces the hardcoded nine-color palette client-side lookup table from R24.5 (`src/lib/label-color.ts`) with a call to the server's own source of truth, so the CLI stops silently drifting if Freelo changes the accepted palette.
**Endpoints:** `GET /task-label-colors`.
**CLI:** `freelo task-labels colors` — lists the current accepted palette (name + hex, if the response provides names; hex-only otherwise).
**Design question for `/spec`:** does this _replace_ the hardcoded `PALETTE` in `label-color.ts` (fetched live, cached with a TTL) or does it ship as a read-only discovery command alongside the existing hardcoded table, with the hardcoded table kept as an offline-safe default? Fetching live on every `--palette` flag use adds a network round-trip to previously-local validation — recommend keeping the hardcoded table as the default/offline path and adding this command as a way to _check_ it's still current, not as a runtime dependency of the existing flag. Revisit at spec time; this is exactly the kind of small UX choice `docs/autonomous-sdlc.md` §Autonomous decisions calls "decide, log."
**Depends on:** R24.5.
**Tier:** Green candidate (read-only, additive).

---

## M06 — `freelo task-labels merge`

**Outcome:** Consolidate duplicate/near-duplicate task labels across every task that carries them, in one server-side operation, instead of manually re-tagging tasks one at a time.
**Endpoints:** `POST /task-labels/merge`.
**Behavior notes (load-bearing):**

- Both `to_uuid` (target) and every `from_uuids` (sources) must be **owned by the caller** — labels the caller doesn't own are treated as **404**, not 403 (consistent with the ACL-hides-existence pattern seen elsewhere in this API, e.g. M01's comment delete).
- Replacement only applies to tasks in projects where the caller is a **commander** — a task in a project where the caller has lesser access silently keeps the old label. Surface this scoping limit in help text; a user merging labels across a large account may be surprised some tasks don't update.
- Target label's name/color come from the existing `to_uuid` label — the client doesn't (and can't) set them via this call.
- Source label _definitions_ are not deleted, only detached from tasks — a follow-up `task-labels delete` (not yet in this roadmap or the original — check if a delete-by-uuid endpoint exists before assuming one does) would be needed to actually remove the leftover source label definitions.
  **CLI:** `freelo task-labels merge --from <uuid>... --to <uuid> [--yes] [--dry-run]` — destructive-adjacent (irreversible relabeling at scale), gate behind confirmation like any other bulk mutation.
  **Depends on:** M04 (needs a way to discover uuids to merge in the first place — pair naturally with `task-labels find`), R13.
  **Tier:** Yellow (new write command, bulk/cross-task blast radius warrants explicit tier review at triage rather than defaulting Green).

---

## M07 — `freelo files delete <uuid>` (extends R25–R27) ✅ shipped

**Status:** **Shipped** — [spec 0064](specs/0064-m07-files-delete.md), run `2026-08-28-2039-files-delete`. Tiered Yellow, confirming the guess below on independently-checked signals (new user-visible command + `minor` changeset).

**Design note worth carrying forward:** the 404 was **not** treated as an idempotent already-deleted success, matching M01's outcome but reached from this endpoint's own text rather than from M01's precedent — `docs/api/freelo-api.yaml` :4504 says a 404 means "no file or document matches the UUID, **or the caller has no access to it**", so absorbing it could report success for a document still sitting untouched in a project the caller cannot see. Note the standing question this leaves for future delete slices: the ACL-hides-existence pattern now looks like Freelo's house style rather than a per-endpoint quirk, so `src/lib/idempotency.ts`'s 404 absorption may be wrong more often than it is right. Check each endpoint's 404 sentence before reusing it.

**Outcome:** Closes the read/write asymmetry in the existing files surface — R25 uploads, R26 lists, R27 downloads, but nothing deletes. Now something does.
**Endpoints:** `DELETE /file/{file_uuid}`.
**Behavior notes:** resolves file vs. document/note automatically from the UUID — one command handles both. Soft-delete only (marked deleted, not physically removed — matches every other delete in this API, including M01's comment delete and the existing task/tasklist deletes). 404 if the UUID doesn't exist or isn't accessible to the caller.
**CLI:** `freelo files delete <uuid>... [--yes] [--dry-run]` / `--ids` / `--stdin`.
**Depends on:** R25, R26 (same resource family), R13 (confirm/delete pattern).
**Tier:** Yellow (new destructive command, additive).

---

## M08 — `tasks list --order-by due_date` (extends R07, already-shipped) ✅ shipped

**Status:** **Shipped** — [spec 0063](specs/0063-tasks-list-order-by-due-date.md), run `2026-08-25-0909-tasks-list-order-by-due-date`. Tiered Yellow, not Green as guessed below (new user-visible flag value + minor changeset); both routes gained `due_date`, not just the tasklist-scoped one.

**Outcome:** `--order-by` on the already-shipped `freelo tasks list --project <p> --tasklist <t>` route gains a fifth value. Small, mechanical, but worth its own tiny slice since R07's CLI flag enum (`src/commands/tasks/list.ts`) needs a one-line update to accept it — right now `due_date` would fail client-side validation before ever reaching the wire.
**Endpoints:** same as R07's tasklist-tasks route (`GET /project/{project_id}/tasklist/{tasklist_id}/tasks`) — no new endpoint, just a new accepted value on an existing query param.
**Behavior notes:** per the upstream description added in this refresh — tasks without a due date always sort last; all-day tasks sort at the start of their day (00:00).
**CLI:** widen the existing `--order-by` enum from `priority|name|date_add|date_edited_at` to include `due_date`, in `src/commands/tasks/list.ts` and the corresponding zod/type unions in `src/api/tasks.ts` / `src/api/schemas/task.ts`. Update `docs/commands/tasks-list.md`'s `## Ordering` section (added by the #108 fix) to mention it.
**Note:** confirm whether `/all-tasks`'s `order_by` enum also gained `due_date` before scoping this — this slice only checked the tasklist-scoped route; the aggregate route's enum wasn't part of this diff pass and may or may not have changed too.
**Depends on:** R07 (shipped), the #108 fix (`freelo-cli@0.20.2`, shipped — this slice is a direct follow-on).
**Tier:** Green candidate (additive enum value on an existing flag, no schema/envelope change).

---

## How to use this doc

Same process as `docs/roadmap.md` §How to use this doc: pick a slice, run `/spec M<NN> — <slice title>`, cite the exact endpoint lines in the now-refreshed `docs/api/freelo-api.yaml`, and re-verify every "Behavior notes" claim above against a live test account before implementing — this doc is roadmap-level analysis of a spec diff, not a substitute for the live-verification discipline `.claude/docs/autonomous-sdlc.md` requires (see the #108 run for what that looks like in practice: static analysis got the _shape_ of the problem right and the _mechanism_ wrong until one live request settled it).

Once a slice ships, add a `✅ shipped` marker and a `**Shipped via:**` line, matching `docs/roadmap.md`'s convention, so this doc stays an accurate tracker rather than drifting into a stale wishlist.
