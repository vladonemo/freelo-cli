---
'freelo-cli': minor
---

R13 — `freelo tasks delete <id>` to soft-delete tasks. **The first
destructive command in the CLI** — gates every wire call behind a
confirmation step.

Three input shapes (mutex):

- Positional: `freelo tasks delete 9012 9013 9014 --yes`
- `--ids`: `freelo tasks delete --ids "9012,9013,9014" --yes`
- `--stdin` NDJSON: `echo '{"id": 9012}' | freelo tasks delete --stdin --yes`

Confirmation policy (new shared helper `src/lib/confirm.ts`, reused by every
later destructive command):

- `--yes` or `--dry-run` → unconditional bypass.
- TTY without `--yes` → prompt once for the whole run (`Delete N task(s)?`,
  default no). Declined → `CONFIRMATION_REQUIRED` (exit 2).
- **Non-TTY without `--yes` → fail closed** with `CONFIRMATION_REQUIRED`
  (exit 2) before any wire call. Agents and CI must opt in explicitly.

Idempotent: a `DELETE /task/{id}` that returns 404 (the task was already
deleted) is re-classified as a success envelope with
`already_in_target_state: true`. The CLI does **not** pre-fetch via GET —
the DELETE response is authoritative and `previous_state` is therefore
`null` in v1.

New envelope: `freelo.tasks.delete/v1`. New schema fields:

- `task_id`, `previous_state` (always `null` in v1), `current_state`
  (always `'deleted'`), `already_in_target_state`, optional `would`
  (dry-run), optional `line_index` (`--stdin` batch).

Batch (`--stdin`) supports continue-on-error semantics with max-of exit
codes per R09/R11/R12.5 precedent.

`@inquirer/prompts` import stays lazy (TTY-prompt branch only) — the
agent cold path never pulls it in.

`destructive: true` in the introspect entry — the first command to set
this. Future destructive commands (`tasks archive`, `subtasks delete`,
`comments delete`, `files delete`, `projects delete`, `tasklists delete`)
will all reuse `confirmDestructive` byte-for-byte.

No new dependencies.
