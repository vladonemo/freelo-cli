---
'freelo-cli': minor
---

R12.5 — `freelo tasks move --stdin` batch input. Move many tasks in one
invocation, each row pointing at its own destination tasklist (and optionally
project). Closes the gap between `tasks move` and the rest of the write
surface that already supports batch.

NDJSON in / NDJSON out, one envelope per row. Per-line shape:
`{"id": <task_id>, "to_tasklist": <tasklist_id>, "to_project"?: <project_id>}`.

- **Continue-on-error semantics** — a bad line does not abort the run; the
  exit code at end-of-run is the max of per-line exit codes (matches R09 /
  R11 batch precedent).
- **Per-row idempotency** — a row whose `to_tasklist` matches the task's
  current tasklist returns `already_in_target_tasklist: true` (no POST).
- **Per-row `to_project` assertion** — same post-move sanity check as
  single-mode `--to-project`, but per-row. Mismatch emits a `notice` on
  that line's envelope; exit stays 0 for that row.
- **`--stdin` is mutex** with positional `<id>`, `--to-tasklist`, and
  `--to-project`. Combining them fails fast with `VALIDATION_ERROR`.

**Schema delta (additive minor):** `freelo.tasks.move/v1` envelopes carry an
optional `data.line_index` field in batch mode. Single-mode envelopes are
**byte-identical** to R12 v1 (no `line_index`).

No new dependencies. No changes to `src/lib/batch.ts` (existing primitives
are already schema-generic).
