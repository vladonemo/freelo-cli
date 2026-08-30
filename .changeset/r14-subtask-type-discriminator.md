---
'freelo-cli': minor
---

Declare `Subtask.type` (`subtask` | `taskcheck`) on `SubtaskSchema`.

**Schema:** `freelo.subtasks.list/v1` gains a documented, validated `type` field. This is
an addition, not a rename or retype — the field already reached output via `.passthrough()`,
so no consumer sees a changed value. `freelo.subtasks.add/v1` is **unchanged**.

`type` is declared optional because `POST /task/{id}/subtasks` does not return it. That was
verified against the live API rather than inferred from the spec: the create response carries
no `type` key on either the smart or the fallback path, while `GET /task/{id}/subtasks`
returns it. Capture and analysis in
`docs/runs/2026-08-29-2230-r14-subtask-type/fixture-capture.md`.

Consequently `inferStorageForm` is **retained**, not retired as originally scoped — `subtasks
add` classifies the create response, where no discriminator exists. Its doc comment now records
that constraint, and that its known mis-classification (a lean smart subtask reads as
`'simple'`) is the common path rather than a corner case. `input_ignored` is unaffected.

Note for future maintenance: `type` is a strict enum, matching how `state` is handled
elsewhere in `src/api/schemas`. A new server-side kind would fail validation rather than
degrade gracefully.
