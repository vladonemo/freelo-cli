# Decision 6 — `edit` takes a single id; `delete`/`finish`/`reopen` take batch input

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** `.claude/CLAUDE.md` says every write command supports batch input (`--id` repeatable, `--ids`, `--stdin` NDJSON). Does `taskchecks edit` get those surfaces?

**Decision:** No. `edit` is single-id (`freelo taskchecks edit <id>`), matching the roadmap's stated CLI shape. `delete`, `finish` and `reopen` get the full batch surface: variadic positional, `--ids`, `--stdin` NDJSON.

**Alternatives considered:**

- **Give `edit` `--stdin` with a `{id, name, worker}` per-line shape.** Deferred, not rejected on principle: it is a coherent surface and the natural way to batch renames. It is a distinct design (per-line bodies, per-line validation, per-line `applied_changes`) that this slice was not asked for, and adding it would widen an already four-command slice.
- **Give `edit` `--ids` applying the same `--name` to every id.** Rejected as near-useless: renaming N checklist items to the same string is not a real workflow, and `--clear-worker` across N ids is thin justification for the surface.

**Rationale:** The batch convention exists because agents drive this CLI, and it pays off where the per-item payload is empty — which is exactly `delete`/`finish`/`reopen` and exactly not `edit`. R10 (`tasks edit`) and M02 (`tasklists edit`, decision 9) both made the same call for the same reason, so this follows established precedent rather than inventing an exception. Noted in `docs/commands/taskchecks.md` as a possible follow-up.
