# Decision 5 — Envelopes omit `already_in_target_state` and `previous_state`; R11's idempotency pattern does not transfer

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** R11's `tasks finish`/`tasks reopen` report `previous_state` and `already_in_target_state`, and `freelo.files.delete/v1` carries `already_in_target_state` pinned to `false` for cross-command uniformity. Do the taskcheck envelopes carry these fields?

**Decision:** No. `freelo.taskchecks.{delete,finish,reopen}/v1` omit both fields entirely. The CLI performs no pre-check GET and makes no claim about prior state.

**Alternatives considered:**

- **Pre-check like R11 and report real values.** Impossible, not merely undesirable: the yaml declares no `GET /taskcheck/{id}`, and a taskcheck id does not reveal its parent task's id, so `GET /task/{parent}/subtasks` is unreachable too. A simple checklist item's prior state is unobservable to this CLI.
- **Emit `already_in_target_state: false` always**, as `freelo.files.delete/v1` does, for uniformity across delete commands. Rejected — see rationale.
- **Emit `already_in_target_state: null`.** Rejected: it types the field as nullable across a schema family where every other resource has it boolean, buying inconsistency in exchange for the same information content as omission.

**Rationale:** A hardcoded `false` asserts "this was not already in the target state", which the CLI does not know and structurally cannot find out. `freelo.files.delete/v1`'s own renderer already describes its copy of the field as "unreachable-true in v1" (`src/ui/human/files-delete.ts:17-21`) — a wart accepted there for cross-resource uniformity, where the underlying question was at least answerable in principle. Here it is not answerable at all. An agent reading `already_in_target_state === false` would be actively misled; one reading `undefined` correctly learns nothing. Whether the server itself no-ops a repeated `finish` is undocumented, so the CLI passes the server's answer through and asserts nothing about it. This is the honest answer to "does R11's pattern transfer?": it does not, and the reason is structural.
