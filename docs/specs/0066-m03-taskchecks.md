# 0066 — M03 `freelo taskchecks` (simple checklist items)

**Run:** `2026-08-29-1046-m03-taskchecks`
**Tier:** Yellow (`docs/runs/2026-08-29-1046-m03-taskchecks/triage.md`)
**Roadmap slice:** `docs/roadmap-migration-2026-08.md` §M03
**Depends on:** R14 (`subtasks`, sibling resource), R13 (`tasks delete` confirm pattern), R11 (`tasks finish/reopen`), M01 (`comments delete`), M07 (`files delete`)
**Type:** `feat` · **Changeset:** `minor`

---

## 1. Problem

R14 shipped `freelo subtasks list` and `freelo subtasks add`. Its own wire wrapper documents (`src/api/subtasks.ts:41-48`) that `POST /task/{id}/subtasks` **transparently falls back** from a *smart* subtask to a *simple* checklist item when the parent's tasklist cannot host smart ones. The user ends up with a `tasks_checks` row.

There is currently no way to manage that row afterwards. It has no `tasks.id`, so every shipped write command — `tasks edit` (R10), `tasks finish`/`tasks reopen` (R11), `tasks delete` (R13) — is inapplicable to it. A user can create a simple checklist item through the CLI and then must open the web UI to rename, tick, untick or remove it. This slice closes that gap.

## 2. API surface — verified against `docs/api/freelo-api.yaml`

Every claim below was read from the pinned OpenAPI document, not from the roadmap summary.

| Operation | Method + path | yaml | Request body |
|---|---|---|---|
| `editTaskcheck` | `POST /taskcheck/{taskcheck_id}` | :2118-2155 | **required** — `name`, `worker` (int, nullable), `notify_author` (bool, default false) |
| `deleteTaskcheck` | `DELETE /taskcheck/{taskcheck_id}` | :2156-2171 | **none declared** |
| `finishTaskcheck` | `POST /taskcheck/{taskcheck_id}/finish` | :2173-2204 | **optional** — `notify_author` (bool, default false) |
| `activateTaskcheck` | `POST /taskcheck/{taskcheck_id}/activate` | :2206-2222 | **none declared** |

Path parameter `TaskcheckIdParam` (:5547-5553): `taskcheck_id`, integer, "ID of the taskcheck (`tasks_checks.id`)".

All four declare exactly one response: `200` → `SuccessResponse`. **No `404` response object is declared on any of the four**, but all four descriptions state the smart-id 404 in prose (:2124, :2161, :2179, :2212).

### 2.1 Correction to the requirement: `notify_author` is NOT uniform

The requirement and the roadmap both assert that "all four endpoints accept an optional `notify_author`… same shape across all four; a shared `--notify-author` flag makes sense." **The OpenAPI contract contradicts this.** `deleteTaskcheck` and `activateTaskcheck` declare no `requestBody` at all.

`autonomous-sdlc.md` §Failure modes is unambiguous: *"Spec says something the OpenAPI spec contradicts → Freelo's contract is authoritative."* The requirement also explicitly instructed "verify each against `docs/api/freelo-api.yaml` directly … don't take this summary on faith" and "verify against the spec text", so correcting the summary is the requested outcome rather than a scope deviation.

`--notify-author` is therefore exposed on **`edit` and `finish` only**. See decision 3.

### 2.2 There is no read endpoint for a single taskcheck

The yaml declares no `GET /taskcheck/{id}`. A single simple checklist item's state can only be observed indirectly, via `GET /task/{parent_task_id}/subtasks` — and a taskcheck id does not tell the CLI its parent's id. This is load-bearing for §5.2.

## 3. The id-space decision

### 3.1 The facts

Two disjoint id spaces exist and the API enforces the split at the HTTP level:

- A **simple** taskcheck is a `tasks_checks` row with `task_id: null`. It responds only on `/taskcheck/{id}…`.
- A **smart** taskcheck has its own `tasks.id`. It returns **404** on all four `/taskcheck/{id}…` paths and is managed through the already-shipped `/task/{id}` paths.

Both id spaces are **plain integers from independent sequences**. The kind is not inferable from the id's shape.

### 3.2 Options weighed

**(a) User picks the command; CLI documents the split and errors clearly on mismatch.**
**(b) CLI auto-probes: try `/taskcheck/{id}`, fall back to `/task/{id}` on 404.**

The roadmap leaned toward (a) but explicitly deferred the call to this spec.

### 3.3 Decision: (a), and the correctness argument is stronger than the roadmap stated

The roadmap framed (b)'s risk as "could mask a genuine 'wrong id' mistake as a silent success." The actual risk is materially worse than masking, because the two id sequences are independent and overlapping in range:

> If a user typos a taskcheck id, or holds a stale id, the fallback path will issue `DELETE /task/<that same integer>`. That integer is very likely to be a **valid, live, unrelated task** the caller owns. Auto-probing does not merely hide an error — it silently performs a destructive write **on a different object than the user named**.

For `delete` this is unrecoverable through the CLI: the delete is a soft-delete and the API exposes no undelete endpoint. `finish`/`reopen` would flip an unrelated task's state. That is categorically unacceptable for a write command, and it is not a risk the user can be warned about after the fact, because from the CLI's perspective the fallback call *succeeded*.

Two further points against (b):

- It doubles the request count on every miss and makes `--yes` consent incoherent: the user consents to deleting a checklist item and may get a task deleted.
- It would make the CLI's behavior depend on a 404 that the yaml never formally declares as a response object (§2), i.e. it would build control flow on undocumented status semantics — precisely the "don't guess API behavior" line.

### 3.4 The UX cost of (a) is already mitigated, today

The objection to (a) is "a user with a checklist item id has to already know or guess which kind it is." They do not have to guess:

1. **A deterministic discovery path already ships.** `freelo subtasks list --task <parent-id>` returns each item's `type` (`subtask` | `taskcheck`) and `task_id` (null for simple ones). The `type` discriminator was added to the `Subtask` schema in the PR #112 spec refresh (`docs/api/freelo-api.yaml:6380-6386`). `SubtaskSchema` (`src/api/schemas/task.ts:438-455`) does not declare `type`, but it is `.passthrough()` and `src/commands/subtasks/list.ts` does no field selection, so `type` and `task_id` **already flow through into `freelo.subtasks.list/v1` JSON output** untouched. The path is available to agents right now.
2. **The mismatch error names the exact fix.** Every 404 from these four endpoints carries a `hint_next` naming the sibling `tasks …` command to run instead (§5.1). One failed call, exit code 4, machine-readable recovery instruction — the agent-first contract working as designed.
3. **Help text states the split up front** on the `taskchecks` parent and on each leaf.

So (a) costs at most one extra round trip in the ambiguous case, and only when the user skipped the listing step. (b) costs, in its bad case, an unrelated deleted task. Decided: **(a)**.

**Out of scope, recommended follow-up:** declare `type` and make `task_id` explicit in `SubtaskSchema` so `freelo.subtasks.list/v1` documents the discriminator rather than leaking it via passthrough, and retire the now-superseded `inferStorageForm` heuristic in `src/api/subtasks.ts:100-133`. That is an R14 change with its own envelope-schema callout and does not belong in this slice.

## 4. CLI surface

```
freelo taskchecks edit   <id> [--name <str>] [--worker <id>|--clear-worker] [--notify-author] [--dry-run]
freelo taskchecks delete <id>... [--ids <list>|--stdin] [--yes] [--dry-run]
freelo taskchecks finish <id>... [--ids <list>|--stdin] [--notify-author] [--dry-run]
freelo taskchecks reopen <id>... [--ids <list>|--stdin] [--notify-author] [--dry-run]
```

`<id>` is a `tasks_checks.id` — a positive integer. Non-integer, zero or negative → `ValidationError`, exit 2, at Commander parse time (calibration §1-2: never `InvalidArgumentError`).

### 4.1 `edit` — single id, deliberately

`edit` takes exactly one `<id>` and no batch surfaces, matching the roadmap's CLI shape. Rationale: the per-item payload differs (you rename item 5 to "X", not all of them), so the batch forms would need per-line bodies, and `--stdin` NDJSON with a `{id, name, worker}` shape is a distinct surface not requested by this slice. `delete`/`finish`/`reopen` carry no per-item payload and so batch cleanly. See decision 6.

Flags:

- `--name <str>` — new name. Empty string rejected (`ValidationError`, exit 2).
- `--worker <id>` — assign worker by user id (positive integer). Mutex with `--clear-worker`.
- `--clear-worker` — emits `worker: null` (yaml :2140 "Pass `null` to clear"). Mutex with `--worker`.
- `--notify-author` — emits `notify_author: true`.
- `--dry-run`.

**At least one mutating flag is required.** `notify_author` alone is not mutating — it is a modifier on a change with nothing to modify. `edit` with no `--name`/`--worker`/`--clear-worker` → `ValidationError`, exit 2, `hint_next` listing the editable fields. This mirrors `isEmptyEditBody` in `src/api/tasklists-edit.ts:102-104`, and is also required by the wire: `requestBody` is `required: true` on this operation.

**The edit surface is intentionally narrow.** `priority_enum`, `priority`, `due_date`, `due_date_end` are documented as 400 on this endpoint (yaml :2124) and are **not** exposed. R10's flag set is not reused. A user needing those fields has a smart subtask, not a simple taskcheck, and should use `tasks edit`.

### 4.2 `delete` / `finish` / `reopen` — batch, mirroring M07

Input sources, exactly one of: positional `<id>...`, `--ids "1,2,3"`, `--stdin` (NDJSON `{"id": <int>}` per line, `.strict()`). Zero resolved ids from any source → silent success, exit 0 (R09/R11/R13/M01/M07 convention). No source at all → `ValidationError`, exit 2.

Single-id runs bubble errors to the top-level handler (one envelope on stderr). Multi-id runs emit a per-item `freelo.error/v1` envelope to stdout with `context.input_index` (positional/`--ids`) or `context.line_index` (stdin), and the highest exit code wins at end of loop. Identical to `src/commands/files/delete.ts:260-381`.

`delete` is destructive: `--yes` or a TTY prompt, confirmed once for the whole run; non-TTY without `--yes` → `ConfirmationError`, exit 2, before any credential resolution or wire call. `--dry-run` skips both the prompt and the call. `finish`/`reopen` are **not** destructive and are not confirmation-gated — they are reversible by each other, matching R11.

`--notify-author` is offered on `finish` only (§2.1). `reopen` and `delete` do not have it; their wire calls send **no body at all**.

### 4.3 Examples

Human, TTY:

```console
$ freelo taskchecks finish 4821
Finished taskcheck 4821.
```

Agent, env-var auth, JSON, batch:

```console
$ FREELO_API_KEY=… FREELO_EMAIL=… freelo taskchecks delete 4821 4822 --yes --output json
{"schema":"freelo.taskchecks.delete/v1","data":{"taskcheck_id":4821,"current_state":"deleted"},"rate_limit":{"remaining":4998,"reset_at":"2026-08-29T11:00:00Z"}}
{"schema":"freelo.taskchecks.delete/v1","data":{"taskcheck_id":4822,"current_state":"deleted"},"rate_limit":{"remaining":4997,"reset_at":"2026-08-29T11:00:00Z"}}
```

Error path — the id was a *smart* taskcheck:

```console
$ freelo taskchecks edit 991 --name "Rewrite intro" --output json
{"schema":"freelo.error/v1","error":{"code":"NOT_FOUND","message":"Taskcheck 991 not found.","http_status":404,"request_id":null,"retryable":false,
 "hint_next":"This endpoint only accepts a *simple* checklist item id (a `tasks_checks.id`). A smart subtask — one with its own task id — returns 404 here; edit it with `freelo tasks edit 991` instead. The id may also simply not exist or not be visible to you. Run `freelo subtasks list --task <parent-id>` and check each item's `type` field (`taskcheck` = simple, use `freelo taskchecks`; `subtask` = smart, use `freelo tasks`).","docs_url":null}}
$ echo $?
4
```

## 5. Idempotency and 404 policy — derived per endpoint

The requirement asked that this be re-derived rather than inherited from R11 or pattern-matched to the M01/M07 delete precedent. It is derived below from two independent properties, applied to each of the four endpoints.

### 5.1 Is a 404 safe to absorb as success? — **No, on all four.** Different reason from M01/M07.

M01 and M07 declined to absorb their 404 because their yaml explicitly documents it as ACL-ambiguous (`files delete`, yaml :4504: "no file or document matches the UUID, **or** the caller has no access to it"). The taskcheck endpoints do **not** declare a 404 response object at all, so that specific ACL wording is absent here and cannot simply be assumed to carry over.

The taskcheck 404 nonetheless must not be absorbed, for a reason the delete precedent does not cover and which applies to all four verbs equally:

> The one 404 meaning these endpoints *do* document (yaml :2124, :2161, :2179, :2212) is **"you passed an id from the other id space."** That is a live, correctable user error with a specific remedy — rerun against `freelo tasks …`. Absorbing it as "already deleted" / "already finished" would report exit 0 for a smart subtask that was never touched, and the user would never learn that their checklist item is still sitting there unmodified.

Absorbing a 404 here would be *worse* than in M01/M07: there, the absorbed case was at least plausibly "already gone." Here the single documented case is "still present, wrong door."

Additionally, the yaml declaring no 404 response object means the CLI has no documented basis to attribute any meaning to that status beyond the prose. Building success semantics on an undeclared status would be guessing.

**Policy: on all four endpoints, a 404 is an error.** `FreeloApiError`, `code: NOT_FOUND`, exit 4, `retryable: false`. The message stays a plain not-found (`Taskcheck <id> not found.`) — it never asserts "you used a smart id", because the CLI cannot distinguish that case from a genuinely nonexistent id. The id-space explanation and the ACL possibility live in `hint_next`, mirroring the M07 message/hint discipline (`src/commands/files/delete.ts:465-495`). Pinned by regression tests so a later "make the deletes consistent" refactor fails loudly.

### 5.2 Is R11's `already_in_target_state` reachable? — **No, on all four.**

R11's `tasks finish`/`tasks reopen` can report `previous_state` and `already_in_target_state` because it pre-checks with `GET /task/{id}` and reads `state.state`. **That pre-check has no equivalent here** (§2.2): there is no `GET /taskcheck/{id}`, and a taskcheck id does not reveal its parent task's id, so the CLI cannot reach `GET /task/{parent}/subtasks` either. A simple checklist item's prior state is **unobservable to this CLI**.

Consequences:

- The CLI does **not** pre-check. There is nothing to pre-check with.
- The envelopes therefore **omit `previous_state` and `already_in_target_state` entirely** rather than hardcoding them. `freelo.files.delete/v1` carries `already_in_target_state` pinned to `false` for cross-command uniformity, and its own renderer calls that value "unreachable-true in v1" (`src/ui/human/files-delete.ts:17-21`). Emitting a field whose value can never be anything but `false`, on a resource where the underlying question is not merely unanswered but unanswerable, would be asserting knowledge the CLI does not have. Omission is honest; a machine consumer reading `already_in_target_state === false` would be misled, whereas one reading `undefined` correctly learns nothing. See decision 5.
- Whether the *server* treats a repeated `finish` as a no-op 200 or an error is **undocumented**, and this spec does not claim either. The CLI passes the server's answer through: a 200 renders as success, any non-2xx surfaces as the corresponding typed error. If Freelo returns 200 on a repeat finish, `freelo taskchecks finish` is idempotent in practice — but the CLI does not *assert* that, because the yaml does not.

This is the correct answer to "does R11's pattern transfer?": **it does not**, and the reason is structural (no read endpoint), not stylistic.

### 5.3 Summary table

| Verb | 404 absorbed as success? | Pre-check GET? | `already_in_target_state` in envelope? | `--notify-author`? | Confirm-gated? |
|---|---|---|---|---|---|
| `edit` | No | No (none exists) | n/a | **Yes** | No |
| `delete` | No | No (none exists) | **No** — omitted | **No** (no request body on the wire) | **Yes** |
| `finish` | No | No (none exists) | **No** — omitted | **Yes** | No |
| `reopen` | No | No (none exists) | **No** — omitted | **No** (no request body on the wire) | No |

## 6. Data model

New file `src/api/schemas/taskcheck.ts`.

```ts
// Wire input, edit only.
export type EditTaskcheckInput = {
  name?: string;
  worker?: number;
  clearWorker?: true;      // mutex with worker
  notifyAuthor?: true;
};
export type EditTaskcheckBody = {
  name?: string;
  worker?: number | null;  // null == clear
  notify_author?: true;
};

// Response validation for all four: bare SuccessResponse, passthrough.
const TaskcheckSuccessSchema = z.object({ result: z.string().nullable().optional() }).passthrough();

// Envelope data.
TaskchecksEditDataSchema = {
  taskcheck_id: int,
  applied_changes: string[],           // e.g. ['name', 'worker'] — echoes which fields were sent
  notify_author: boolean,              // echoed so an agent can confirm what it asked for
  would?: { method: 'POST', path: string, body: unknown },
}
TaskchecksDeleteDataSchema = {
  taskcheck_id: int,
  current_state: 'deleted',
  would?: { method: 'DELETE', path: string, body: unknown },
  line_index?: int,
}
TaskchecksTransitionDataSchema = {          // shared by finish + reopen, mirrors R11
  taskcheck_id: int,
  verb: 'finish' | 'reopen',
  current_state: 'finished' | 'active',
  notify_author: boolean,
  would?: { method: 'POST', path: string, body: unknown },
  line_index?: int,
}
```

Envelope schema strings: `freelo.taskchecks.edit/v1`, `freelo.taskchecks.delete/v1`, `freelo.taskchecks.finish/v1`, `freelo.taskchecks.reopen/v1`. All four are new — no existing schema is touched, so there is no `/v(n+1)` bump anywhere in this slice.

`current_state` on `delete`/`finish`/`reopen` is **derived from the verb**, not from the server (the 200 body is a bare `SuccessResponse` with no entity). This matches `files delete`'s handling and is documented as such in the schema comments.

## 7. Errors

| Situation | Class | `code` | exit | retryable |
|---|---|---|---|---|
| `<id>` not a positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| `--worker` not a positive integer | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| `--name ""` | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| `--worker` + `--clear-worker` | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| `edit` with no mutating flag | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| more than one input source | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| no input source at all | `ValidationError` | `VALIDATION_ERROR` | 2 | no |
| `delete` non-TTY without `--yes` | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | no |
| `delete` TTY prompt declined | `ConfirmationError` | `CONFIRMATION_REQUIRED` | 2 | no |
| 404 (any of the four) | `FreeloApiError` | `NOT_FOUND` | 4 | no |
| 400 (e.g. a field the endpoint rejects) | `FreeloApiError` | passthrough | 4 | no |
| 401 / 403 / 429 / 5xx / network | existing client mapping, unchanged | — | — | — |

No new error class. No exit code changes. The 404 `hint_next` copy is specified in §4.3.

There is deliberately **no 400 message rewrite**. M01 rewrote its 400; this slice does not, because the only documented 400 cause here (sending `priority`/`due_date`) is unreachable through the CLI — those flags do not exist on this command. Inventing copy for a 400 the user cannot trigger would be dead code and a permanent coverage hole (calibration §4).

## 8. Non-goals

- **No auto-probing / id-kind sniffing** (§3.3).
- **No `taskchecks list` / `taskchecks show`** — no read endpoint exists (§2.2); listing is `freelo subtasks list`.
- **No `taskchecks add`** — creation is already `freelo subtasks add` (R14), which is what produces these rows.
- **No `--priority` / `--due` on edit** — 400 on the wire (§4.1).
- **No batch surfaces on `edit`** (§4.1).
- **No change to `SubtaskSchema` / `freelo.subtasks.list/v1`** — recommended follow-up, out of scope (§3.4).
- **No real network calls.** MSW only; `allowNetwork: false`.

## 9. Open questions

None. The two candidates were resolved against the OpenAPI contract: the id-space strategy (§3.3) and `notify_author`'s per-endpoint availability (§2.1). Both are recorded in `docs/decisions/`.

---

## Plan

### 9.1 New files

| File | Intent |
|---|---|
| `src/api/schemas/taskcheck.ts` | Zod: `TaskcheckSuccessSchema`, `EditTaskcheckInput`/`Body`, `TaskchecksEditDataSchema`, `TaskchecksDeleteDataSchema`, `TaskchecksTransitionDataSchema` + inferred types. |
| `src/api/taskchecks.ts` | Wire wrappers + path builders + pure body builder: `editTaskcheckPath`, `deleteTaskcheckPath`, `transitionTaskcheckPath`, `buildEditTaskcheckBody`, `isEmptyEditTaskcheckBody`, `editTaskcheck`, `deleteTaskcheck`, `transitionTaskcheck`. |
| `src/commands/taskchecks.ts` | Parent registrar; description states the simple-vs-smart split. Mirrors `src/commands/subtasks.ts`. |
| `src/commands/taskchecks/edit.ts` | Single-id edit. Flag parsing, mutex checks, empty-body check, dry-run, 404 rewrite. |
| `src/commands/taskchecks/delete.ts` | Batch delete. Confirm gate. Modelled on `src/commands/files/delete.ts`, ids as ints. |
| `src/commands/taskchecks/transition.ts` | Shared batch finish/reopen implementation, parameterised by verb. Mirrors `src/commands/tasks/transition.ts`. |
| `src/commands/taskchecks/finish.ts` | 5-line registrar delegating to `transition.ts` (mirrors `src/commands/tasks/finish.ts`). |
| `src/commands/taskchecks/reopen.ts` | Ditto for `reopen`. |
| `src/ui/human/taskchecks-edit.ts` | `Edited taskcheck <id> (name, worker).` / `(dry-run) Would edit …`. |
| `src/ui/human/taskchecks-delete.ts` | `Deleted taskcheck <id>.` / dry-run form. No "already deleted" branch (§5.1). |
| `src/ui/human/taskchecks-transition.ts` | `Finished taskcheck <id>.` / `Reopened taskcheck <id>.` / dry-run forms. No "already in state" branch (§5.2). |
| `docs/commands/taskchecks.md` | User docs: the id-space split up front, 4 commands, ≥2 realistic examples each, permissions note. |
| `.changeset/<name>.md` | `minor`; lists the four new envelope schemas explicitly. |

### 9.2 Modified files

| File | Change |
|---|---|
| `src/bin/freelo.ts` | Lazy-import + call `registerTaskchecks`, alphabetically beside `registerSubtasks`. |
| `test/msw/handlers.ts` | Handlers for the four paths + a 404 fixture representing the smart-id case. |
| `README.md` | Regenerated autogen Commands block via `pnpm fix:readme`. |
| `docs/roadmap-migration-2026-08.md` | Mark M03 shipped; record the tier outcome and the two contract corrections (`notify_author` non-uniformity; R14 `type`-discriminator follow-up). |

### 9.3 Tests

`test/commands/taskchecks/{edit,delete,finish,reopen}.test.ts` plus `test/api/taskchecks.test.ts` for the pure builders.

What each must prove:

- **Pure builders** (no MSW): `buildEditTaskcheckBody` omits unset keys; `--clear-worker` emits `worker: null`; `--worker 7` emits `worker: 7`; `notify_author` emitted only when true; `isEmptyEditTaskcheckBody` treats a `notify_author`-only body as empty. Path builders produce the exact four wire paths.
- **Happy paths** (MSW): each of the four verbs emits its envelope with the right `schema` string and derived `current_state`. Assert **request body content**, never request counts (repo MSW double-fire artifact).
- **`edit` body content**: `--name` only sends `{name}`; `--clear-worker` sends `{worker: null}`; `--notify-author` sends `notify_author: true`.
- **`delete`/`reopen` send no body** — assert the received body is empty, which is the machine-checkable form of §2.1.
- **404 is an error, not success** — one test per verb: exit code **4**, `code: NOT_FOUND`, and the `hint_next` mentions both `freelo tasks` and `freelo subtasks list`. These are the §5.1 regression pins.
- **`already_in_target_state` / `previous_state` absent** from every success envelope — an explicit assertion, so a future "consistency" refactor that adds them fails (§5.2 pin).
- **Exit-code assertions on every error path in §7** (calibration §2), covering `ValidationError` (2), `ConfirmationError` (2), `FreeloApiError` (4).
- **Confirmation gate on `delete`**: non-TTY without `--yes` → exit 2, **no wire call**; `--dry-run` → no prompt, no wire call. The TTY-prompt-copy test must `delete process.env.CI` and restore in `finally` (calibration §7).
- **Batch**: multi-id per-item error envelopes with `context.input_index`; `--stdin` NDJSON with `context.line_index`; mixed good/bad batch yields the highest exit code; empty stdin → exit 0 silent.
- **Dry-run**: `would.method`/`would.path`/`would.body` correct for all four; no credentials resolved.
- **Introspection**: `freelo --introspect` enumerates `taskchecks` and its four leaves with the right `outputSchema` values.

### 9.4 New dependencies

**None.**

### 9.5 Rollout

Single landable slice. Additive only — no existing command, schema, flag or exit code changes, so it cannot break an existing consumer.

### 9.6 Gate order (calibration §3)

After commit, on the clean committed tree: `pnpm typecheck && pnpm lint && pnpm test:cov && pnpm build && pnpm check:readme`. `test:cov` specifically, not `pnpm test` — the branch-coverage threshold is only enforced by the former, and CI enforces it (memory note: orchestrator coverage gate).

---

`ARCHITECT run=2026-08-29-1046-m03-taskchecks status=ok spec=docs/specs/0066-m03-taskchecks.md open_questions=0 new_deps=0`
