# 0068 — M06 `freelo task-labels merge`

**Status:** implemented
**Run:** `2026-08-29-2050-m06-task-labels-merge`
**Roadmap:** `docs/roadmap-migration-2026-08.md` §M06
**Depends on:** M04 (`task-labels find`, spec 0062), R13 (confirm/delete pattern, spec 0024),
M07 (`files delete`, spec 0064 — closest structural sibling), M05 (`task-labels colors`, spec 0067)

---

## 1. Problem

A Freelo account accumulates near-duplicate task labels: `bug` / `Bug` / `BUG`, three shades of
"urgent", the same label minted twice by two integrations. `POST /task-labels` is a
**fetch-or-create keyed on name AND colour, case-sensitively** (yaml :2911), so duplicates are not
an accident of misuse — they are what the API produces when two callers disagree about
capitalisation or shade.

Today the only way to consolidate them from the CLI is to find every task carrying the loser
label, `task-labels attach` the winner, and `task-labels detach` the loser, one task at a time.
There is no CLI surface for the server-side operation that does exactly this in one call.

## 2. Contract verification

Every roadmap claim was re-derived from `docs/api/freelo-api.yaml` rather than carried over. All
four hold; two carry nuance the roadmap did not.

| Roadmap claim | Verdict | Evidence |
|---|---|---|
| `POST /task-labels/merge`, body `{ from_uuids: string[], to_uuid: string }`, both required | **confirmed** | yaml :2936-2973 |
| Non-owned labels → `404`, not `403` | **confirmed, and declared by this endpoint itself** | yaml :2947 |
| Replacement applies only where the caller is a commander | **confirmed verbatim** | yaml :2948 |
| Target name/colour come from the existing `to_uuid` label | **confirmed** | yaml :2951 |
| Source label definitions survive the merge | **confirmed** | yaml :2952 |
| "a follow-up `task-labels delete` would be needed" | **not implementable** | see §2.2 |

### 2.1 The 404 is this endpoint's own claim, not a pattern match

M03 decision 4 established that the M01/M07 ACL-hides-existence reasoning does **not** transfer to
endpoints that declare no `404` response object. That caution does not bite here, but for a reason
worth stating precisely, because the surface signal points the other way:

- The `responses:` map declares **only `'200'`** (yaml :2974-2981). There is no `404` response
  object. On the M03 test alone, this endpoint would fail it.
- But the endpoint's **own prose** says it outright: *"Both the target (`to_uuid`) and every source
  label (`from_uuids`) must be owned by the caller; otherwise the endpoint responds `404` (labels
  the caller does not own are treated as non-existent)"* (yaml :2947).

M03's rule was "derive the 404 policy from this endpoint's own contract." Doing exactly that gives
a 404 policy here — sourced from the description rather than the response map, which is where this
yaml consistently puts its non-obvious behaviour. The 404 is **documented**, so the CLI handles it
explicitly; it is documented as **ambiguous** (missing vs. not-owned), so the CLI does not claim to
know which. See §5.2.

### 2.2 There is no `task-labels delete` endpoint — the roadmap's follow-up cannot be built

The roadmap says leftover source definitions would need "a follow-up `task-labels delete` (not yet
in this roadmap or the original — check if a delete-by-uuid endpoint exists before assuming one
does)". Checked. It does not exist.

Every path in the contract carrying a label concept:

```
/project-labels/find-available          GET
/project-labels/{labelId}               GET, PUT, DELETE   <- project labels, id-keyed
/project-labels/add-to-project/{id}     POST
/project-labels/remove-from-project/{id} POST
/task-labels/find-available             GET
/task-label-colors                      GET
/task-labels                            POST               <- bulk create only
/task-labels/merge                      POST
/task-labels/add-to-task/{task_id}      POST
/task-labels/remove-from-task/{task_id} POST
```

`DELETE /project-labels/{labelId}` exists, but **project labels are a different resource** — id-keyed,
scoped to a project, served by `freelo labels` (R23). Task labels are uuid-keyed and global. There
is no `DELETE /task-labels/{uuid}` and no delete verb anywhere under `/task-labels`.

**Consequence, and it is user-visible:** after a merge, the source label definitions remain in the
caller's account forever, detached from every task but still present in
`task-labels find` output and still offered by Freelo's own label picker. Nothing in the CLI or the
API can remove them. This is stated in help text, in the human renderer, and in the docs page —
it is the single most likely "did the merge work?" support question, and the honest answer is
"yes, and the empty husk you are looking at is expected and permanent."

### 2.3 `task-labels find` is a superset of "labels you own", not an ownership oracle

Relevant because the not-found path wants to point at it (§4, design question 3).
`GET /task-labels/find-available` returns *"all task labels usable by the authenticated user —
labels attached to tasks across the caller's owned **and invited** projects"* (yaml :2847). Merge
requires **ownership**. So `find` can list a label that merge will 404 on, and the CLI cannot tell
the two apart before the call. The hint text says so rather than implying `find` is a pre-flight
check.

## 3. Proposal — CLI surface

```
freelo task-labels merge --from <uuid> [--from <uuid> ...] --to <uuid> [--yes] [--dry-run]
```

| Flag | Required | Notes |
|---|---|---|
| `--from <uuid>` | yes, ≥1 | Repeatable. Each occurrence also accepts a comma- or space-separated list, so `--from "$(… \| paste -sd,)"` works without shell fan-out. |
| `--to <uuid>` | yes, exactly 1 | The surviving label. Its name and colour are unchanged by this call. |
| `--dry-run` | no | Skips the POST **and** the confirmation prompt. |
| `--yes` / `-y` | no | Global flag, read off the root program. Bypasses the prompt. |

Examples:

```bash
# consolidate three spellings of "bug" into the canonical one
freelo task-labels merge \
  --from 0d0d5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --from 1e1e5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f \
  --to   9f9f5e6f-1a2b-4c3d-9e8f-0a1b2c3d4e5f --yes

# preview first — no wire call, no prompt
freelo task-labels merge --from A --from B --to C --dry-run --output json

# pipeline form: one --from carrying a comma-separated list
freelo task-labels merge --from "$(freelo task-labels find --output json \
  | jq -r '.data.labels[] | select(.name|ascii_downcase=="bug") | .uuid' | paste -sd,)" \
  --to 9f9f… --yes
```

### 3.1 Input validation (all `ValidationError`, exit 2)

Calibration §2: every one of these has a test asserting exit 2.

1. `--from` absent or resolving to zero uuids → `ValidationError`. **Not** the batch convention's
   silent-success-on-empty (R09/R11/R13/M01): those commands have a legitimate empty *source*
   (an empty stdin stream). Here `--from` is a required argument of a single operation; its absence
   is a malformed invocation, matching `files delete`'s `sourceCount === 0` branch.
2. `--to` absent → `ValidationError`. Deliberately **not** Commander's `.requiredOption()`, which
   exits 1 (calibration §2 — the R04 `parseProjectId` class of bug).
3. Any uuid failing the strict 8-4-4-4-12 hex check → `ValidationError` at parse time, before
   credentials are resolved.
4. `--to` also appearing in `--from` (case-insensitively) → `ValidationError`. The contract does
   not say what the server does with a self-merge and the CLI will not find out on the user's
   data. Fails closed client-side.
5. Duplicate `--from` uuids are **de-duplicated** (case-insensitive, first spelling wins) rather
   than rejected — a `jq | sort` pipeline emitting a repeat is a user convenience problem, not an
   error, and the resulting wire body is identical either way.

## 4. Design decisions

Recorded in full under `docs/decisions/2026-08-29-2050-m06-task-labels-merge-*.md`. Summarised:

**D1 — the success envelope reports what was *sent*, never what was *changed*.**
The 200 body is `SuccessResponse` = `{ result: "success" }` (yaml :5567-5572). No task count, no
per-task detail, no list of what moved. So `data` carries `to_uuid`, `from_uuids`, `count` (source
labels, matching the sibling `task_labels.*` envelopes) — all of which are echoes of the request —
and **no** `tasks_updated`, `tasks_skipped`, or `already_in_target_state`. M03 decision 5 is the
precedent: omit the field entirely rather than hardcode a value the CLI cannot know.

**D1b — one constant is carried: `scope: "commander_projects"`.**
This is the exception to "say nothing", and the reasoning is that it is not a measurement. The
contract states unconditionally that replacement applies only where the caller is a commander
(yaml :2948); the field restates that contract fact, is true of every invocation, and is typed as
`z.literal` so its constancy is visible in the schema rather than inferred. Without it, a JSON
consumer sees an unqualified success and reasonably concludes the merge was complete — the exact
silent-partial-success failure this slice exists to make visible, and one that help text cannot
reach because agents do not read help text. A count would be fabrication; a contract restatement
is not.

**D2 — `--from` is repeatable and comma-splitting; there is no `--ids` and no `--stdin`.**
The repo's batch convention (`--id` repeatable / `--ids` / `--stdin` NDJSON) exists to let one
invocation drive N *independent operations* and report a per-item envelope for each. Merge is one
HTTP call whose body already carries the array. There is no per-source request to amortise and no
per-source result to report, so `--stdin` would have to mean either "one source per line" (which
breaks the one-line-one-operation contract that `line_index` and the per-line error envelope are
built on) or "one merge per line" (a different, unrequested command). M03 decision 6 drew this
line by asking where a per-item payload is empty; here the per-item payload does not exist at all.
Comma-splitting inside `--from` recovers the pipeline ergonomics `--ids` would have provided, at
zero new surface: a uuid can never contain a comma, so the split is unambiguous.

**D3 — the 404 hint points at `task-labels find`, and admits its limits.**
Yes, warranted: `find` is the only uuid-discovery surface and the whole slice presumes it. But per
§2.3 it lists a *superset* of owned labels, so the hint says the label "may exist but not be yours"
and names `find` as a starting point, not a check. Pointing at it without that caveat would send
users in a circle: `find` shows the label, merge keeps 404-ing, nothing explains why.

## 5. Behaviour

### 5.1 Confirmation gate — the core of the slice

Delegated to `src/lib/confirm.ts` (R13), same contract as `files delete`:

| State | Behaviour |
|---|---|
| `--yes` | Proceed. Highest precedence. |
| `--dry-run` | Proceed, no prompt. No destructive effect exists to gate. |
| TTY, no `--yes` | Prompt once, default **no**. Decline → `ConfirmationError`, exit 2, **zero requests**. |
| Non-TTY, no `--yes` | `ConfirmationError` (`CONFIRMATION_REQUIRED`, exit 2) **immediately** — before credential resolution, before any wire call. Fails closed. |

The prompt copy is built by an exported `mergeConfirmMessage(fromCount, toUuid)` so it can be
asserted in a plain unit test where `isInteractive()` does not apply (calibration §7's preferred
form). It names the irreversibility explicitly:

```
Merge 3 labels into 9f9f…4e5f? Every task carrying them is relabeled. This cannot be undone.
```

Integration tests still cover the TTY branch end-to-end, and clear `process.env.CI` in a `try` with
a `finally` restore (calibration §7 — the R23 failure class).

### 5.2 Error surface

Only the 404 is rewritten. There is deliberately **no 400 branch**: this endpoint documents no 400
(the `responses:` map has one entry, `'200'`), and inventing a message for an undocumented status
is guessing at API behaviour. Same reasoning as M07.

The 404 stays an **error**. It is never absorbed into an idempotent success, even though merge is
notionally idempotent (a second identical merge is a no-op because no task carries the source label
any more). The CLI cannot distinguish "already merged" from "you do not own this label" from "this
uuid never existed" — and reporting success for a merge that never touched the user's data is the
one failure mode this command must not have. `src/lib/idempotency.ts` is not used here.

| Status | Class | Exit | Message / hint |
|---|---|---|---|
| 404 | `FreeloApiError` (rewritten) | 4 | *"One or more of the labels was not found."* Hint names ownership, the 404-not-403 behaviour with a yaml line reference, and `task-labels find` with the superset caveat. |
| 401 | `FreeloApiError` `AUTH_EXPIRED` | 3 | pass-through |
| 403 | `FreeloApiError` | 4 | pass-through |
| 429 | `RateLimitedError` | 6 | pass-through |
| 5xx | `FreeloApiError` `SERVER_ERROR` | 4 | pass-through |
| network | `NetworkError` | 5 | pass-through |
| bad input | `ValidationError` | 2 | §3.1 |
| no confirm | `ConfirmationError` | 2 | §5.1 |

### 5.3 Dry-run

Skips the POST and the prompt, resolves no credentials (mirrors M01/M07's null-client path), and
emits `dry_run: true` with `would: { method: 'POST', path: '/task-labels/merge', body }` — the
body being the exact object that would have gone over the wire, after de-duplication.

## 6. Data model

New envelope: **`freelo.task_labels.merge/v1`**.

```ts
{
  to_uuid: string,
  from_uuids: string[],           // de-duplicated, input order preserved
  count: number,                  // from_uuids.length
  scope: 'commander_projects',    // literal; see D1b
  would?: { method: 'POST', path: string, body: unknown }
}
```

Wire response schema reuses the existing `SuccessResponseSchema` in
`src/api/schemas/task-label.ts` — the same one `create` / `attach` / `detach` already validate
against.

## 7. Edge cases

- **Empty `--from` after de-dup** — impossible; de-dup cannot empty a non-empty list.
- **`--from` and `--to` differing only in hex case** — treated as the same uuid → self-merge
  `ValidationError`. Tested.
- **A source label attached to no tasks** — 200, nothing happens. Indistinguishable from a merge
  that moved 10 000 tasks. This is the honesty problem in §D1, and the envelope does not pretend
  otherwise.
- **Rate limit / pagination** — not applicable; one call, no pagination.

## 8. Non-goals

- Resolving label **names** to uuids. `--from bug` is not accepted. Name→uuid is
  `task-labels find`'s job and name matching is case-sensitive and colour-qualified server-side;
  guessing which of three `bug` labels the user meant is exactly the ambiguity this command exists
  to remove.
- Deleting the leftover source label definitions (§2.2 — no endpoint exists).
- Reporting which tasks changed (§D1 — the API does not say).
- Batch *merges* (multiple `--to` groups in one invocation).

## 9. Open questions

None. All three design questions resolved above with logged decisions.

---

## Plan

### Files

| File | Change |
|---|---|
| `src/api/schemas/task-label.ts` | +`TaskLabelsMergeDataSchema` / `TaskLabelsMergeData`. Reuses `SuccessResponseSchema` and the local `WouldSchema`. |
| `src/api/task-labels.ts` | +`TASK_LABELS_MERGE_PATH`, +`buildMergeTaskLabelsBody`, +`mergeTaskLabels`. |
| `src/commands/task-labels/merge.ts` | **new** — command, parsers, validation, confirm gate, dry-run, 404 rewrite, exported `mergeConfirmMessage`. |
| `src/commands/task-labels.ts` | register the new leaf; update the parent doc comment (five → six leaves). |
| `src/ui/human/task-labels-merge.ts` | **new** — live / dry-run renderer + the two-caveat note. |
| `test/msw/handlers.ts` | +`mergeOk`, `mergeOkWhenBody`, `mergeNotFound`, `mergeServerError`, `mergeNetworkError`, `mergeRateLimited` on `taskLabelsHandlers`. |
| `test/commands/task-labels/merge.test.ts` | **new** — full suite, `warmUpCli`-style `beforeAll`. |
| `docs/commands/task-labels-merge.md` | **new** — user docs. |
| `README.md` | autogen Commands block via `pnpm fix:readme`. |
| `.changeset/*.md` | minor, with the schema line called out. |
| `docs/roadmap-migration-2026-08.md` | mark M06 shipped. |

**No new dependencies.**

### Test strategy

Unit (no CLI round-trip): `renderTaskLabelsMergeHuman` both branches; `mergeConfirmMessage`
singular/plural and irreversibility copy.

Integration (MSW): happy path `--yes`; multi `--from`; comma-list `--from`; de-dup; wire-body
assertion via `mergeOkWhenBody` (assert content, never request counts — resolvers can fire twice);
`--dry-run` (no request, no prompt, `would` body); human output; non-TTY without `--yes` → exit 2;
TTY decline → exit 2 + zero requests; TTY accept → exit 0 (both clearing `CI`); missing `--to`;
missing `--from`; bad uuid in each of `--from` / `--to`; self-merge; 404 rewrite (message +
hint content, and a regression assertion that it is **not** absorbed into success); 401/403/429/5xx
/network exit codes; `--introspect` shows `destructive: true` and the new schema.

Absence assertions (pinned so a later "make the writes consistent" refactor fails loudly):
envelope has no `tasks_updated`, no `already_in_target_state`, no `previous_state`.

### Rollout

Single landable slice.
