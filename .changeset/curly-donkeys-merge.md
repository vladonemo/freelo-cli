---
'freelo-cli': minor
---

Add `freelo task-labels merge --from <uuid>... --to <uuid>` (M06, spec 0068) — consolidate
duplicate task labels in one server-side call instead of re-tagging tasks by hand. Maps to
`POST /task-labels/merge`.

**New envelope schema `freelo.task_labels.merge/v1`** (additive; no existing schema changes).
`data` carries `to_uuid`, `from_uuids`, `count` and the constant `scope: "commander_projects"`.
It deliberately carries **no** `tasks_updated` / `tasks_skipped` / `already_in_target_state`: the
API's 200 body is `{"result": "success"}` and reports no per-task detail, so any count would be
fabricated. The `scope` literal is there so a JSON consumer cannot read success as completeness.

This is the most destructive command in the CLI — irreversible bulk relabeling with no undo
endpoint — so it follows the R13/M07 gate: `--yes` or a TTY prompt, and non-TTY without `--yes`
fails closed with `CONFIRMATION_REQUIRED` (exit 2). `--dry-run` reaches neither the network nor the
credential store.

Two contract limits are surfaced in help text, human output and docs because they are invisible in
the response: the replacement reaches only tasks in projects where you are a commander (tasks
elsewhere silently keep the old label), and the source label definitions are detached but never
deleted — Freelo exposes no delete endpoint for task labels at all.

A 404 (label missing *or* not owned by you — the API collapses the two) stays an error and is never
absorbed into an idempotent success.
