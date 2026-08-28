---
'freelo-cli': minor
---

feat(comments): `freelo comments delete <id>...` — delete your own comments

Adds the delete verb to the `comments` resource, wrapping `DELETE /comment/{comment_id}`. This
closes out R18.5, queued since 2026-04-28 because the endpoint wasn't in Freelo's OpenAPI document;
the 2026-08-24 refresh added it. Mirrors `freelo tasks delete`: `--yes` / TTY-confirm gate,
`--dry-run`, and all three batch input shapes (positional `<id>...`, `--ids`, `--stdin` NDJSON).
No new flag names and no new flag semantics — every surface already exists elsewhere in the CLI.

**New envelope schema: `freelo.comments.delete/v1`.** Additive; no existing schema is touched.
`data` carries `comment_id`, `current_state: "deleted"`, `already_in_target_state`, plus the usual
optional `would` (dry-run) and `line_index` (`--stdin`) fields.

Two Freelo-side rules shape the error surface, and both are worth knowing before scripting against
this command:

- **15-minute deletion window.** A comment can only be deleted within 15 minutes of being posted;
  after that the API returns 400. Rather than passing through a generic `Freelo API error (HTTP
  400).`, the CLI names the cause and points at `freelo comments edit`, which has no time limit and
  is the real workaround for redacting an older comment.
- **A 404 is an error here, not an idempotent already-deleted success.** This is a deliberate
  divergence from `tasks delete` / `projects delete` / `labels delete`, which all absorb a 404 into
  a success envelope with `already_in_target_state: true`. Only a comment's author may delete it,
  and Freelo returns 404 rather than 403 for someone else's comment so that inaccessible comments
  aren't leaked — which makes a 404 mean *either* "no such comment" *or* "not yours". Absorbing it
  would report success for a comment still sitting in the thread. It therefore surfaces as
  `NOT_FOUND` / exit 4, with a plain not-found message (never a permission error) and the ACL nuance
  confined to `hint_next`. `already_in_target_state` is consequently always `false`; it is retained
  only so agents looping deletes across resources read one field shape everywhere.

Scripts that loop over comment ids and tolerate "already gone" must check for this explicitly — a
404 from `comments delete` does not mean the work is done.
