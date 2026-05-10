---
'freelo-cli': minor
---

feat(commands): `notes` and `pins` (R44)

Seven new subcommands across two new top-level command parents — the **final
slice of Wave 7**, closing the wave with R44 merged.

**`notes`** (project-level rich-text notes; share storage with documents internally):

- `freelo notes create --project <id> --name <str> [--content ...|--from-file ...|--editor|-]`
  — create a project note. Content is optional (name-only notes are valid).
  Wire: `POST /project/{id}/note`.
- `freelo notes show <id>` — fetch a single note (full detail, including
  embedded files/comments). Wire: `GET /note/{id}`.
- `freelo notes edit <id> [--name ...] [--content ...|--from-file ...|--editor|-]`
  — overwrite name and/or content. Wire: `POST /note/{id}` (verb is POST per
  Freelo's OpenAPI; the roadmap PATCH was incorrect). When only `--content` is
  supplied, the CLI issues a transparent `GET /note/{id}` first to fetch the
  current name, because the wire body requires `name`.
- `freelo notes delete <id>... [--ids ...|--stdin] [--yes] [--dry-run]` —
  soft-delete (destructive, batch). Wire: `DELETE /note/{id}`. **API quirk:**
  the DELETE response is the deleted Note's last state, not a SuccessResponse
  — the CLI surfaces this on `data.note` for audit-log use cases. 404-idempotent
  (single-arm).

**`pins`** (project-level pinned items — links, tasks, documents, files):

- `freelo pins list --project <id>` — list all pinned items, ACL-filtered
  server-side. Wire: `GET /project/{id}/pinned-items`.
- `freelo pins add --project <id> --link <url> [--title ...]` — pin a URL.
  Wire field is `link` (not `url`), matching Freelo exactly. Server-side
  dispatcher: internal-resource URLs are fetch-or-create idempotent;
  external URLs always create a new pin.
- `freelo pins remove <id>... [--ids ...|--stdin] [--yes] [--dry-run]` —
  remove pins (destructive, batch). Wire: `DELETE /pinned-item/{id}`.
  Underlying targets unaffected. 404-idempotent (single-arm).

**Schemas added (additive — no existing schema changed):**

- `freelo.notes.create/v1` — `{ project_id, note?, byte_length, source }`.
- `freelo.notes.show/v1` — `{ note }`.
- `freelo.notes.edit/v1` — `{ note_id, note?, applied_changes, source, byte_length }`.
- `freelo.notes.delete/v1` — `{ note_id, note?, previous_state, current_state, already_in_target_state, line_index?, would? }`.
- `freelo.pins.list/v1` — `{ project_id, pins[] }`.
- `freelo.pins.add/v1` — `{ project_id, pin?, applied_link, applied_title?, would? }`.
- `freelo.pins.remove/v1` — `{ pin_id, previous_state, current_state, already_in_target_state, line_index?, would? }`.

**Notable scope decision:** `notes list` is **NOT** included — Freelo's
documented OpenAPI has no project-scoped notes/documents listing endpoint.
The gap is documented in spec 0058 §5; reserved for R45+ when an endpoint
becomes available.

Closes Wave 7 (custom fields + notes + pinned items).
