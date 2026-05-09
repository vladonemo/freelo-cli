# Decision 2 — `clear` always emits `already_in_target_state: false` on live 200

**Run:** 2026-05-09-1200-tasks-remind
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** Should the `clear` envelope distinguish "had a reminder, deleted it" from "had no reminder, no-op"?

**Decision:** No. Live `200` always emits `already_in_target_state: false`. Only a defensive `404` (forward-compat path) is re-classified as `already_in_target_state: true`.

**Alternatives considered:**
- GET pre-check before DELETE — double round-trip on a destructive path; matches R13 decision 4's rejection.
- Always emit `true` — would lie when we actually deleted a real reminder.
- Always emit `false` AND drop the field entirely from the live envelope — schema mismatch with the dry-run / 404 paths; agents would need to defensively check key presence.

**Rationale:** Be honest about wire ambiguity. The Freelo server collapses both cases into `200 SuccessResponse` (yaml :2125); we surface that with `already_in_target_state: false` and let agents decide. Forward-compat 404 catch keeps us safe if Freelo ever tightens the endpoint.
