---
'freelo-cli': minor
---

feat(files): `freelo files delete <uuid>...` — delete files and documents

Closes the read/write asymmetry in the `files` resource. R25 uploads, R26 lists and R27 downloads;
until now nothing deleted. This adds the delete verb, wrapping `DELETE /file/{file_uuid}`. The
endpoint resolves whether a UUID points at a **file** or a **document/note** server-side, so one
command covers both.

Mirrors `freelo comments delete` and `freelo tasks delete`: `--yes` / TTY-confirm gate, `--dry-run`,
and all three batch input shapes (positional `<uuid>...`, `--ids`, `--stdin` NDJSON, the last taking
`{"uuid": "<string>"}` lines). No new flag names and no new flag semantics — every surface already
exists elsewhere in the CLI.

**New envelope schema: `freelo.files.delete/v1`.** Additive; no existing schema is touched. `data`
carries `uuid`, `current_state: "deleted"`, `already_in_target_state`, plus the usual optional
`would` (dry-run) and `line_index` (`--stdin`) fields. It deliberately carries no `type` / `kind`
field: the API never reports which of the two kinds it removed, so surfacing one would be a guess.

**A 404 is reported as an error (exit 4), not as an idempotent already-deleted success.** This
diverges from `freelo tasks delete` on purpose, and it is the thing to know before scripting against
this command. Freelo returns 404 both when the resource is gone *and* when it exists but the caller
can't see it — the API doesn't distinguish, to avoid leaking the existence of inaccessible resources.
Absorbing that into a success would print "deleted" and exit 0 for a document still sitting untouched
in someone else's project, which is the one failure mode a delete command must never have. So
`already_in_target_state` is always `false` here, the message stays a plain not-found (the CLI cannot
tell which case it hit, so it doesn't claim to), and the ambiguity is spelled out in `hint_next`.
Passing the same UUID twice therefore reports the second as a 404 — de-duplicate upstream if you need
tolerance.

Deletion is a **soft delete** on Freelo's side: the resource is marked deleted rather than physically
removed. There is no undelete endpoint.
