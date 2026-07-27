---
'freelo-cli': patch
---

fix(api): accept comment file attachments that carry no `id` (#105)

`freelo tasks edit <id>` failed with `VALIDATION_ERROR` (exit 4) for any task
whose first comment has a file attachment:

```
Unexpected response shape from GET /task/<id>:
[{ code: "invalid_type", expected: "number", received: "undefined",
   path: ["comments", 0, "files", 0, "id"], message: "Required" }]
```

The failing call was the **lookup `GET /task/{id}`** that `tasks edit` issues
before writing — so the edit aborted before any mutation. Issue #105 reported
this as a `POST` failure; that was a reconstruction of an uncaptured error
string, and all six hypotheses it ranked were wrong. A real captured
`POST /task/{id}` body validates fine.

The actual cause: the internal file schema behind `TaskDetail.comments[].files[]`
and `GET /task/{id}/description` declared `id` and `uuid` as required, but
Freelo's embedded file DTO carries no numeric `id`. Both fields are now
`.nullable().optional()`, matching the two sibling file-ref schemas
(`FileFullRefSchema`, `NoteFileRefSchema`) and this module's own stated
convention. Fields still validate when present.

Freelo's OpenAPI contract agrees: `FileBasic` declares no required properties
at all, so this removes a constraint the CLI invented rather than widening one
the API asked for.

Fixes `tasks show`, `tasks edit`, `tasks move`, and `tasks description get`
on affected tasks.

**Envelope:** no field removed, renamed, or retyped — `data.task` output is
byte-identical for bodies that already validated, so no `/v2` bump. One caveat
for consumers: `data.task.comments[].files[].id` was previously guaranteed to
be a number *or* the command hard-failed. It may now be absent. That guarantee
was counterfeit — it was the bug.
