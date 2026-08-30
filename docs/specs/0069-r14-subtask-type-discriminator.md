# 0069 — R14: declare `Subtask.type`, reassess the `storage_form` derivation

**Status:** **Blocked — open questions unresolvable without a live API response.**
**Run:** `2026-08-29-2230-r14-subtask-type`
**Tier:** Red (see `docs/runs/2026-08-29-2230-r14-subtask-type/triage.md`)
**Supersedes-in-part:** spec 0025 §4.4 (storage-form inference heuristic)

---

## 1. Problem

`docs/api/freelo-api.yaml` declares a `Subtask.type` discriminator that the CLI does not
model. `src/api/subtasks.ts:121` `inferStorageForm` guesses the same distinction from which
fields happen to be populated, and its own doc comment records the resulting false-negative.
If `type` is authoritative, the guess is redundant and sometimes wrong.

## 2. Contract verification (done — this is settled)

Read directly from the tree at `32b6ead`. Nothing here is inferred.

### 2.1 `type` permitted values — confirmed

`docs/api/freelo-api.yaml:6379-6382`:

```yaml
type:
  type: string
  enum: [subtask, taskcheck]
  description: 'Subtask kind discriminator: `subtask` = smart subtask (has its own
    `task_id`), `taskcheck` = simple checklist item (`task_id` is null). ...'
```

The M03 roadmap note's `subtask | taskcheck` is correct.

### 2.2 Required or optional — not marked required

The `Subtask` schema (yaml :6374-6433) has **no `required:` block at all**. Neither does
`id` nor `name`. So "optional" here is the schema's uniform posture for response objects, not
a positive statement that the server may omit `type`. **The yaml does not tell us whether a
real response always carries `type`.** This is open question OQ-2.

### 2.3 Which endpoints return it — both

- `GET /task/{task_id}/subtasks` (yaml :2775) returns `items: $ref: Subtask` — feeds `freelo.subtasks.list/v1`.
- `POST /task/{task_id}/subtasks` (yaml :2810) returns `schema: $ref: Subtask` — feeds `freelo.subtasks.add/v1`.

So `type` is in scope for **both** shipped subtasks commands.

### 2.4 `type` already reaches output today — verified empirically

`SubtaskSchema` is `.passthrough()`, so an undeclared `type` survives parsing. Executed
against the tree at `32b6ead`:

```
SubtaskSchema.parse({ id: 1, name: 'x', type: 'subtask' })
  -> {"id":1,"name":"x","type":"subtask"}
```

**Consequence:** declaring `type` is observationally a **no-op** on the wire envelope. It
changes the typed contract, not the emitted JSON. That materially lowers the risk of the
declaration half of this slice — and it is the reason the two halves have different tiers.

### 2.5 Current test coverage of `type` — zero

No fixture in `test/msw/handlers.ts`, `test/commands/subtasks/`, or `test/fixtures/` sets
`type`. Every existing subtasks test exercises responses in which `type` is absent.

## 3. Is `type` the same distinction as `storage_form`? (point 2)

**Provisionally yes on vocabulary, but the repo's own fixtures contradict the yaml.**

Vocabulary maps cleanly: yaml `subtask` = "smart subtask"; spec 0025 §2.2.1 calls the same
thing a "smart taskcheck". yaml `taskcheck` = "simple checklist item"; spec 0025 calls it a
"simple taskcheck". Same distinction, two names. So far so good.

### 3.1 The contradiction (new finding, not in the requirement)

The yaml says the discriminator co-varies with `task_id`:

> `subtask` = smart subtask (**has its own `task_id`**), `taskcheck` = simple checklist item
> (**`task_id` is null**).

But spec 0025 models the simple shape as carrying `task_id`:

- spec 0025:152 — `"simple"` is "the lean `{ id, task_id, name, date_add? }` shape"
- spec 0025:460 (test 20) — "Simple-shape response (`{id, task_id, name, date_add}`)"
- shipped unit test `test/api/subtasks.test.ts:65-68` —
  `inferStorageForm({ id: 1, task_id: 9012, name: 'lean' })` asserts `'simple'`

Under the yaml's semantics, `{ id: 1, task_id: 9012, name: 'lean' }` has a non-null
`task_id` and is therefore a **`subtask` (smart)**, not a taskcheck. The repo's canonical
"this is what simple looks like" fixture would be a smart subtask.

`inferStorageForm` never inspects `task_id` at all, so the two models have never been forced
to agree.

**Why this matters for the slice:** it is not established that `type` and the heuristic agree
on the CLI's own test data. If the yaml's `task_id` reading is right, switching to `type`
does not fix a rare corner case — it flips the **common** lean-response case from `simple` to
`smart`. That is the difference between a narrow bug fix and a broad behavior change, and it
is unresolved. This is OQ-1.

Two readings of `task_id` are possible and the yaml does not disambiguate:

- (i) `task_id` = the id of the backing Task object (null for a checklist row) — the yaml's
  description reads this way;
- (ii) `task_id` = the parent task id (always present) — spec 0025 assumed this.

## 4. Breaking-change assessment (point 3 — the crux)

### 4.1 What changes observably

Only in the case where `type` says smart AND all of `worker` / `due_date` / `due_date_end` /
`state` / `tasklist` / `project` are null. Today this yields `storage_form: "simple"`;
afterwards `"smart"`.

Three consequences, not one:

1. `data.storage_form` value flips.
2. `data.input_ignored` disappears when the user passed `--worker` / `--due`, because
   `input_ignored` is only computed on the `simple` branch (`src/commands/subtasks/add.ts:429`).
3. Human output flips (`src/ui/human/subtasks-add.ts:35-44`): `"Created subtask #N."`
   instead of `"Created simple taskcheck #N. (Server fell back ...)"`.

### 4.2 Bug fix or contract change?

Honest answer: **it depends on OQ-1, which is unresolved.**

- *Fix* reading: the field is documented as reporting "which form was actually persisted"
  (spec 0025:160). If the server persisted a smart subtask and we say `simple`, we report the
  wrong thing. Spec 0025 itself lists this as a false-negative and a Risk (0025:579).
- *Contract-change* reading: consequence (2) is the sharp edge. An agent that passed
  `--worker` and got `input_ignored: ['worker']` was told **the worker was discarded**. After
  the change it is told nothing, i.e. "unknown" per the repo's absent-means-unknown precedent.
  Those are opposite claims about whether a write took effect. And the post-change claim is
  only more correct if a lean smart response really does mean the worker was applied — which
  the yaml does not say and we cannot observe.

### 4.3 Does `freelo.subtasks.add/v1` need a `/v2`?

By the letter of `CLAUDE.md` ("field removal / rename / retype = breaking; additions =
minor"), **no**: nothing is removed, renamed or retyped, and the enum domain `{smart, simple}`
is unchanged. A value correction is not enumerated.

By intent, **arguably yes**: an agent branching on `storage_form` / `input_ignored` sees
different behavior for identical inputs across the upgrade, with no signal that the semantics
moved. The version string is the only channel we have for "this field now means something
slightly different".

The rule does not decide it. That is a maintainer call, not an orchestrator call — OQ-3.

### 4.4 Conclusion

The change as scoped is **breaking behavior of an existing command**, which
`.claude/docs/autonomous-sdlc.md` routes to **Pause**, not decide-and-log. Combined with
"don't guess the API", the run pauses here rather than implementing.

## 5. Absent-`type` behavior (point 4)

Not decidable until OQ-2 is answered, but the options are:

- **A. Heuristic survives as an explicit fallback.** `type` authoritative when present,
  `inferStorageForm` when absent. Keeps the export and its 9 unit tests meaningful; needs new
  tests for the precedence rule. Safest against an older or partial server response. Cost: two
  code paths that can disagree, and the debt is not actually retired.
- **B. `type` required; heuristic deleted.** Cleanest, retires the debt. But if any real
  response omits `type`, `subtasks list` and `add` start failing schema validation — turning
  a cosmetic mislabel into a hard error on a shipped command. Not justifiable while OQ-2 is open.
- **C. `type` declared optional, `storage_form` omitted when `type` is absent.** Honest
  (absent means unknown, matching the `paging` / `rate_limit` precedent) but removes a field
  that spec 0025 §4.2 documents as "always present in live envelopes" — an unambiguous
  breaking change to `freelo.subtasks.add/v1`.

## 6. A note on declaring the enum

If `type` is declared as `z.enum(['subtask', 'taskcheck'])`, a future third value from the
server becomes a **validation failure** on a shipped read command. `.passthrough()` currently
tolerates anything. Whatever is decided above, the declaration should be lenient
(for example `z.string()` with the enum documented, or a catch-all) rather than strict.
Flagged for the plan phase; not itself a pause trigger.

## 7. Non-goals

- Other `.passthrough()` cleanups or schema declarations (explicit scope boundary).
- Lifting `warmUpCli` into a shared test helper (separate queued debt).
- Resolving `task_id` semantics repo-wide — only insofar as it bears on OQ-1.

## 8. Open questions

- **OQ-1 (blocking).** Does `type` agree with `inferStorageForm` on a real lean response? That
  is, is `{ id, task_id, name, date_add }` a `taskcheck` (heuristic right, narrow fix) or a
  `subtask` (heuristic wrong on the common case, broad behavior change)? Turns on the `task_id`
  semantics contradiction in §3.1. **Needs a captured fixture; run is `allowNetwork: false`.**
- **OQ-2 (blocking).** Does a real response always carry `type`? The yaml marks nothing
  required, so this is unanswerable from the contract. Determines §5 A vs B.
- **OQ-3 (blocking, maintainer call).** If the derivation changes, does
  `freelo.subtasks.add/v1` become `/v2`? §4.3 shows the written rule does not decide it.
- **OQ-4 (non-blocking).** Should the `task_id` contradiction be filed as its own contract
  correction against the yaml, or against spec 0025?

## 9. Plan

Not written. The plan phase is not entered while §8 has blocking open questions
(`.claude/docs/sdlc.md` Phase 2 — the plan is the contract, and there is no settled contract yet).
