# Triage — 2026-04-29-1500-r24-task-labels

**Tier:** Yellow
**Commit type:** feat

## Summary

Add `freelo task-labels` top-level command with three subcommands: `create` (bulk), `attach` (to a task by name or uuid), and `detach` (from a task by name or uuid). Wraps three Freelo endpoints: `POST /task-labels`, `POST /task-labels/add-to-task/{task_id}`, `DELETE /task-labels/remove-from-task/{task_id}`. This is a sibling of R23's `freelo labels` (project-labels) but a separate Freelo concept — global/task-scoped labels, not project-labels.

## Signals
- [x] Touches src/commands/ (new subcommand `task-labels`)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (NEW envelopes: `freelo.task_labels.create/v1`, `freelo.task_labels.attach/v1`, `freelo.task_labels.detach/v1` — additive)
- [ ] Changes exit codes
- [ ] Removes/renames an existing flag
- [x] Requires the Freelo API
- [ ] Docs-only

## Route flags
- requiresFreeloApi: true
- needsSecurityReview: false
- preApprovedDeps: []
- allowNewDeps: false

## Rationale

Three new user-visible subcommands → Yellow per autonomous-sdlc.md (additive new commands stop at PR for human review). No auth/config/HTTP-client changes. No new dependencies expected. New envelope schemas are additive (new versioned schema names, not modifications to existing). Pattern is well-established by recent `labels`/`subtasks`/`tasks` slices.

## Open concerns

- Architect must verify exact request/response shape of all three task-labels endpoints in `docs/api/freelo-api.yaml` — do not guess.
- Architect must confirm: does `POST /task-labels` accept multiple names in one call, or is it one-name-per-request? `(bulk create)` annotation in roadmap suggests bulk; OpenAPI is authoritative.
- Architect must clarify the `--name` vs `--uuid` selector semantics for attach/detach: does the server-side endpoint take name strings, label uuids, or both? OpenAPI is authoritative.
- Confirm idempotency: re-attaching an already-attached label should be a success-noop per project working-agreement.

## Recommended branch name

`feat/task-labels`
