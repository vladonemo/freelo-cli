# Decision 3 — `freelo.comments.delete/v1` data shape

**Run:** 2026-08-25-0813-comments-delete
**Phase:** Spec
**Agent:** architect

**Question:** `DELETE /comment/{id}` declares no 200 response schema, so there is nothing server-derived to surface. What goes in the envelope's `data`, given `TasksDeleteData` carries `task_id` / `previous_state` / `current_state` / `already_in_target_state`?

**Decision:** `{ comment_id, current_state: 'deleted', already_in_target_state, would?, line_index? }`. Drop `previous_state`. Keep `already_in_target_state` even though decision 1 pins it to `false` forever in v1, and type it `z.boolean()` rather than `z.literal(false)`.

**Alternatives considered:**

- Full `TasksDeleteData` parity including `previous_state: null`.
- Minimal `{ comment_id, would?, line_index? }` — drop both `current_state` and `already_in_target_state` as derived constants.
- Keep `already_in_target_state` but type it `z.literal(false)` so the type system itself documents that this command never absorbs.

**Rationale:** `previous_state` in `TasksDeleteData` is a task-lifecycle enum that the delete path hardcodes to `null` anyway; comments have no lifecycle enum, so carrying it would be null-typed noise on a brand-new schema. `already_in_target_state` earns its place despite being constant: an agent looping deletes across `tasks` / `projects` / `labels` / `comments` reads one field shape everywhere, and removing a field later is a breaking schema change while never adding it is merely a missing convenience. `z.literal(false)` was tempting and more self-documenting, but it makes the TypeScript type `false`, so if Freelo ever exposes a way to distinguish "already deleted" from "not yours", widening to `boolean` would be a retype — breaking under the envelope contract in `.claude/CLAUDE.md`. `z.boolean()` with a doc comment costs nothing and keeps that door open.
