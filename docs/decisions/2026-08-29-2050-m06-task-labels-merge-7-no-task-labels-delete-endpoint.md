# Decision 7 — Contract correction: no task-label delete endpoint exists, so leftovers are permanent

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect / freelo-api-specialist role)

**Question:** The roadmap says leftover source label definitions "would need a follow-up
`task-labels delete`" and asks that the existence of a delete-by-uuid endpoint be checked before
assuming one. Does it exist?

**Decision:** It does not. The docs and help text say the leftovers are permanent rather than
implying a missing CLI feature, and no follow-up roadmap item is filed.

Every label-bearing path in `docs/api/freelo-api.yaml`:

```
/project-labels/find-available            GET
/project-labels/{labelId}                 GET, PUT, DELETE
/project-labels/add-to-project/{id}       POST
/project-labels/remove-from-project/{id}  POST
/task-labels/find-available               GET
/task-label-colors                        GET
/task-labels                              POST    (create only)
/task-labels/merge                        POST
/task-labels/add-to-task/{task_id}        POST
/task-labels/remove-from-task/{task_id}   POST
```

The only DELETE is on `/project-labels/{labelId}` — a **different resource** (project labels,
id-keyed, served by `freelo labels`; task labels are uuid-keyed and global). There is no
`DELETE /task-labels/{uuid}` and no delete verb anywhere under `/task-labels`.

**Alternatives considered:**

- Assume the roadmap was right and file a follow-up "add `task-labels delete`" item. Rejected: it
  would be unbuildable, and a roadmap item nobody can start is worse than a documented limitation.
- Say nothing about the leftovers. Rejected: "the merge worked but the old label is still in my
  picker" is the most likely support question this command generates, and the honest answer is
  "expected, and permanent."

**Rationale:** The roadmap explicitly asked for this to be checked rather than assumed. It was
checked; the answer inverts the framing from "missing follow-up step" to "permanent property of the
API", which changes what the help text and docs have to say.
