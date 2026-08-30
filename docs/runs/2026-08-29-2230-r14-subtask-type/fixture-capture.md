# Fixture capture — R14 OQ-1 / OQ-2 (option D)

**Run:** 2026-08-29-2230-r14-subtask-type
**Captured:** 2026-08-30 22:18 Europe/Prague
**Authorised by:** Vlado, 30 Aug 2026 — dedicated test account supplied, writes confirmed.
**Account:** dedicated Freelo test account (not production). Project `Freelo-test` (628610).
**Raw log:** `fixture-capture-raw.json` (unscrubbed — scrub author name/id before reuse as a test fixture).

## What was created

| Object | id | note |
|---|---|---|
| Tasklist | 1991798 | `R14 fixture 1788121106093` |
| Task | 32125435 | parent |
| Subtask (smart) | 18510609 | own `task_id` 32125436 |
| Subtask (nested) | 18510610 | created under 32125436 → hit the documented fallback |

## OQ-2 — does a real response always carry `type`? **No. Decisive.**

- `POST /task/{id}/subtasks` → **no `type` field at all**, on either the smart create or the
  fallback create. Response keys: `id, task_id, name, due_date, due_date_end, worker,
  priority_enum, labels, comment, tracking_users`.
- `GET /task/{id}/subtasks` → **`type` present**: `"subtask"` (18510609), `"taskcheck"` (18510610).

**Consequence: options B and C are not implementable as specified.** `storage_form` in
`subtasks add` is computed from the POST response, which has no `type`. Deriving it from `type`
would require an extra GET per add — the exact round-trip spec 0025 §4.4 rejected on cost.

## OQ-1 — does `type` agree with `inferStorageForm`? **No, on the common case.**

Executed `inferStorageForm` (real import, not reimplemented) against the captured POST bodies:

```
id=18510609  task_id=32125436  type-in-POST=undefined
   GET says: subtask (smart)  -> expected 'smart'
   inferStorageForm() = 'simple'   *** DISAGREES ***

id=18510610  task_id=null     type-in-POST=undefined
   GET says: taskcheck (simple) -> expected 'simple'
   inferStorageForm() = 'simple'   AGREES
```

The POST response shape never includes `state`, `tasklist` or `project`, so `inferStorageForm`
can only return `'smart'` when `worker`/`due_date`/`due_date_end` are set. **Any subtask created
with `--name` alone is labelled `'simple'` regardless of what it actually is.** This is the
limitation the code comment already admits; the capture shows it is the *common* path, not a corner.

## The `task_id` contradiction — the yaml is right, spec 0025 is wrong

Real data: smart subtask → `task_id: 32125436` (populated); taskcheck → `task_id: null`.

`test/api/subtasks.test.ts:65-68` asserts `inferStorageForm({id:1, task_id:9012, name:'lean'})
=== 'simple'`. **That input is not a shape the API produces** — a populated `task_id` means
smart. The test passes only because `inferStorageForm` never inspects `task_id`. Spec 0025
:152 / :460 model the simple shape the same wrong way.

## `input_ignored` is NOT broken today

Triage feared the flip could reverse a claim about whether a write took effect. It does not:
`input_ignored` is computed only on the `'simple'` branch, and only from flags the user passed.
If `--worker` was honoured, the response carries it → `'smart'` → correctly no `input_ignored`.
If the fallback discarded it, the response has `worker: null` → `'simple'` → correctly reported.
The mislabel is confined to `storage_form` when no rich fields were passed — cosmetic.

## Where this leaves the decision

B and C are ruled out by the contract, not by risk appetite. What the evidence supports:

1. Declare `type` on `SubtaskSchema` — **optional**, since it is absent on POST.
2. Keep `inferStorageForm` for `add`. It cannot be retired there; no `type` is available.
3. Optionally prefer `type` in `subtasks list`, where it is authoritative.
4. Fix `test/api/subtasks.test.ts:65-68` — it encodes an impossible response shape.
5. Correct spec 0025 §4.4's model of the simple shape.
6. Land these captures as scrubbed fixtures.

That is option A's scope, reached for a stronger reason than A was originally offered:
not "safer", but "the only thing the API permits".
