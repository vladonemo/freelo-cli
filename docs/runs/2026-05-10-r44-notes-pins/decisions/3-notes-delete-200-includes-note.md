# Decision 3 — `notes delete` 200 envelope includes `data.note`

**Run:** 2026-05-10-r44-notes-pins
**Phase:** Spec
**Agent:** architect

**Question:** Freelo's `DELETE /note/{id}` response body is the deleted Note's last state, not a SuccessResponse (yaml :4669 — "this is a quirk"). What should the CLI envelope carry?
**Decision:** On a live 200, include `data.note` with the deleted Note's last state for audit-log use cases. On a 404-idempotent skip, omit `data.note` (no body to echo).
**Alternatives considered:**
- Always omit `data.note` (uniform shape across success and idempotent skip).
- Always include `data.note`, with `null` on idempotent skip.
**Rationale:** The API quirk gives us a useful audit signal for free. Surfacing it on the envelope helps consumers track "what was the note's last state before deletion?" without a follow-up GET. Omitting it on the idempotent path keeps the schema honest — there is no body to echo when the server returns 404. Both paths set `current_state: 'deleted'` and `previous_state: null` so the schema shape is otherwise consistent.
