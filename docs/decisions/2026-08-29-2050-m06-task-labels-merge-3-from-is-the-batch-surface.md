# Decision 3 — `--from` is repeatable and comma-splitting; no `--ids`, no `--stdin`

**Run:** 2026-08-29-2050-m06-task-labels-merge
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** `CLAUDE.md` requires writes to support batch input (`--id` repeatable, `--ids`,
`--stdin` NDJSON). Does merge get all three surfaces, or is the merge itself already the batch?

**Decision:** `--from` is repeatable **and** splits a comma/space-separated list per occurrence, so
`--from a --from b` and `--from a,b` are equivalent. No `--ids` flag and no `--stdin`.

**Alternatives considered:**

- The full trio (`--from` repeatable + `--from-ids` + `--stdin`). Rejected: `--stdin` NDJSON would
  have to mean either "one source uuid per line" — which breaks the one-line-one-operation contract
  that `line_index` and the per-line error envelope are built on, since a line here is not an
  operation — or "one whole merge per line", which is a different, unrequested command with a
  per-line `to_uuid`.
- `--from` repeatable only, no comma-splitting, plus a separate `--from-ids`. Rejected as two flags
  and a mutex-error branch where one flag suffices: a uuid can never contain a comma or whitespace,
  so the split is unambiguous and cannot be misused.

**Rationale:** The repo's batch convention exists to amortise N HTTP calls and report a per-item
result for each. Merge is one call whose wire body already holds the array; there is no per-source
request to amortise and no per-source result to report. M03 decision 6 drew this line by asking
where the per-item payload is empty — here the per-item payload does not exist at all. The
comma-split recovers the pipeline ergonomics `--ids` would have provided, at zero new surface.
