---
'freelo-cli': minor
---

Add `freelo taskchecks` (M03) — a new resource for managing **simple checklist items**, the lightweight `tasks_checks` rows `freelo subtasks add` silently falls back to when a tasklist can't host smart subtasks. Until now the CLI could create them but never edit, tick, un-tick or remove one.

```bash
freelo taskchecks edit 4821 --name "Draft the introduction" --worker 512
freelo taskchecks finish 4821 4822
freelo taskchecks reopen 4821
freelo taskchecks delete 4821 --yes
```

**Four new envelope schemas:** `freelo.taskchecks.edit/v1`, `freelo.taskchecks.delete/v1`, `freelo.taskchecks.finish/v1`, `freelo.taskchecks.reopen/v1`. No existing schema is changed, and no existing command's behavior changes.

Notable behavior:

- **Two id spaces, and the CLI won't guess between them.** These commands accept only a *simple* checklist item id (`tasks_checks.id`). A *smart* subtask — one with its own task id — returns 404 here and is managed with `freelo tasks edit|delete|finish|reopen`. The CLI deliberately does not probe-and-fall-back: the two id sequences are independent and overlap in range, so a typo'd checklist id is quite likely to be a valid, live, unrelated task, and a fallback would quietly act on the wrong object. Every 404 instead carries a `hint_next` naming the right command and the `freelo subtasks list` discovery path (read each item's `type`: `taskcheck` = simple, `subtask` = smart).
- **A 404 is never an idempotent success**, on any of the four verbs — unlike `freelo tasks delete`. The one 404 cause the API documents here is "wrong id space", meaning the item is still there, untouched.
- **No `already_in_target_state` / `previous_state`** in these envelopes, unlike every other write command. Freelo has no `GET /taskcheck/{id}`, so a checklist item's state is genuinely unobservable; emitting a hardcoded `false` would assert knowledge the CLI doesn't have.
- **`--notify-author` is on `edit` and `finish` only.** `DELETE /taskcheck/{id}` and `POST /taskcheck/{id}/activate` declare no request body in the OpenAPI contract, so `delete` and `reopen` send none and don't offer the flag. (The migration roadmap claimed all four accepted it; the contract disagreed and won.)
- **`edit` exposes only `--name` and `--worker`/`--clear-worker`** — a much smaller surface than `tasks edit`. The endpoint returns 400 for priority and due-date fields, so those flags are not defined rather than defined-and-doomed.
- `delete` is confirmation-gated (`--yes` or a TTY prompt); `finish`/`reopen` are not, being exact inverses of each other. `delete`, `finish` and `reopen` all support batch input (positional, `--ids`, `--stdin` NDJSON); `edit` is single-id.
