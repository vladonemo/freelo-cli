## Paused at Spec (phase 2 of 13)

**Run:** 2026-08-29-2230-r14-subtask-type
**Reason:** Retiring `inferStorageForm` in favour of `Subtask.type` changes the observable output of the shipped `subtasks add` command, and the evidence needed to judge whether that is a fix or a regression requires a live API response this run is not allowed to make.
**Risk tier:** Red

### What happened

Contract verification succeeded and settled the factual questions: `Subtask.type` is
`enum: [subtask, taskcheck]` (yaml :6379-6382), it is **not** marked required (the `Subtask`
schema has no `required:` block at all), and it is returned by both the `list` GET and the
`add` POST. It also already reaches envelope output today via `.passthrough()` — verified by
executing `SubtaskSchema.parse` — so **declaring** it is observationally a no-op.

The derivation change is not. Switching `storage_form` to read `type` flips the field's value,
can **remove** `data.input_ignored`, and changes the human-renderer string, for a shipped
command. While reading spec 0025 to check the mapping, a contradiction surfaced that decides
how large that blast radius is: the yaml says a `taskcheck` has `task_id` null, but spec 0025
and the shipped unit test both model the *simple* shape as `{ id, task_id, name, date_add }`
with `task_id` populated. If the yaml is right, the change flips the **common** lean-response
case, not a rare corner — and `inferStorageForm` never inspects `task_id`, so the two models
have never been forced to agree. Resolving this needs a real response; the run is
`allowNetwork: false`.

### Evidence

- `docs/api/freelo-api.yaml:6379-6382` — `type: enum [subtask, taskcheck]`; description: "`subtask` = smart subtask (has its own `task_id`), `taskcheck` = simple checklist item (`task_id` is null)".
- `docs/api/freelo-api.yaml:6374-6433` — no `required:` block anywhere in `Subtask`.
- `docs/specs/0025-subtasks-list-add.md:152` and `:460` — simple shape modelled as `{ id, task_id, name, date_add? }`, `task_id` present.
- `test/api/subtasks.test.ts:65-68` — `inferStorageForm({ id: 1, task_id: 9012, name: 'lean' })` asserts `'simple'`.
- `src/commands/subtasks/add.ts:429` — `input_ignored` computed **only** on the `simple` branch, so it vanishes when the form flips to `smart`.
- `src/ui/human/subtasks-add.ts:35-44` — human output branches on `storage_form`.
- Executed against `32b6ead`: `SubtaskSchema.parse({id:1,name:'x',type:'subtask'})` -> `{"id":1,"name":"x","type":"subtask"}`.
- No fixture in `test/msw/handlers.ts` or `test/commands/subtasks/` sets `type` — zero current coverage.
- Full analysis: `docs/specs/0069-r14-subtask-type-discriminator.md` §3-§5.

### Decision needed

How should this slice proceed, given that `type` is authoritative in the contract but its
agreement with the existing heuristic is unverified?

Options:

  A. **Split — land the declaration only.** Declare `type` on `SubtaskSchema` (leniently, per
     spec 0069 §6), leave `inferStorageForm` and `storage_form` untouched. Non-breaking
     (already in output), ships today, Yellow.
     *Tradeoff:* the actual debt — the heuristic — is not retired, and `type` is declared but
     unused, which the requirement explicitly warned against in the mirror-image case.

  B. **Full change, `type` authoritative with the heuristic as documented fallback**
     (spec 0069 §5A), accept the value flip, call it out in the changeset as a behavior change
     but keep `freelo.subtasks.add/v1`.
     *Tradeoff:* if OQ-1 resolves the yaml's way, this silently flips the common case for every
     agent branching on `storage_form` / `input_ignored`, with no version signal.

  C. **Full change plus `freelo.subtasks.add/v2`.** Same as B, with an envelope version bump so
     consumers get an explicit signal that the semantics moved.
     *Tradeoff:* a `/v2` for a single field's derivation is heavy, and `CLAUDE.md`'s breaking
     rule (removal / rename / retype) does not actually require it.

  D. **Capture a fixture first.** Re-run with `--allow-network` against a test account to answer
     OQ-1 and OQ-2, then decide B vs C on evidence.
     *Tradeoff:* needs a test account and a network-enabled run; slowest, but the only option
     that stops guessing.

  E. Abort the run.

If you pick B or C, please also answer **OQ-2** (does a real response always carry `type`?),
since it decides whether the heuristic stays as a fallback or is deleted outright.

### Resume with

```
/resume 2026-08-29-2230-r14-subtask-type <A|B|C|D|E or free-form answer>
```
