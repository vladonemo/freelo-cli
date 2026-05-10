# Decision 2 — `notes edit --content` (no `--name`) uses GET-then-POST

**Run:** 2026-05-10-r44-notes-pins
**Phase:** Spec
**Agent:** architect (orchestrator-delegated)

**Question:** Wire requires `name` even on a content-only edit (yaml :4647-4648). How should `notes edit --content "..."` (no `--name`) populate `name`?
**Decision:** Issue a transparent `GET /note/{id}` first to fetch the current name, then POST with `{ name: <fetched>, content: <new> }`. The auto-fetch GET error (404 / 403) bubbles before any POST, so a missing/inaccessible note never produces a half-written edit.
**Alternatives considered:**
- Require `--name` on every edit.
- Send `name: ""` and let the server validate.
- Add a `force-edit` mode that bypasses the requirement (not possible — server validates).
**Rationale:** Requiring `--name` on every edit would break the "change just the body" UX precedent set by `comments edit` and similar single-field-edit commands. Sending `name: ""` is rejected server-side with 400. The GET-then-POST flow preserves natural CLI ergonomics with one extra HTTP call.
