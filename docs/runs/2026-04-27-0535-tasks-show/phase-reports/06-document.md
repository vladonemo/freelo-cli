# Phase report — Document

**Run:** 2026-04-27-0535-tasks-show
**Phase:** Document (doc-writer)
**Status:** Complete

## Outputs

- `docs/commands/tasks-show.md` — user-facing doc covering synopsis,
  arguments, options, endpoints (with the projection-not-HTTP note
  for `--with projects`), envelope shape, side-car presence semantics,
  three-state `data.projects` handling, multi-project membership
  rationale, examples (agent JSON + jq + human TTY), errors, and
  deliberate non-goals.
- `docs/roadmap.md` — R08 endpoint list updated to drop
  `GET /task/{task_id}/projects` and add a one-line note explaining
  the embedded-projection (per decision 1).
- `README.md` — autogen Commands block regenerated via
  `pnpm fix:readme` to include `freelo tasks show <id>`. CI gate
  `pnpm check:readme` clean.
- `.changeset/r08-tasks-show.md` — `minor` bump entry calling out
  the new `freelo.tasks.show/v1` envelope schema.

```
DOC-WRITER phase=document run=2026-04-27-0535-tasks-show status=ok files=4
```
