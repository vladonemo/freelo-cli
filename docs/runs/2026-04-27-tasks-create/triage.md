# Triage — 2026-04-27-tasks-create

**Tier:** Yellow
**Commit type:** feat

## Summary
Add `freelo tasks create` — the first write-class subcommand. It POSTs a new task to a tasklist with optional workers, label(s), due date, priority, and description, supports `--dry-run` and NDJSON batch via `--stdin`, and ships the shared write infrastructure (`src/lib/dry-run.ts`, `src/lib/batch.ts`, NDJSON streamer) that every later write slice will reuse.

## Signals
- [x] Touches src/commands/ (new subcommand)
- [ ] Touches src/config/
- [ ] Touches src/api/client.ts or HTTP defaults
- [ ] Touches auth flows
- [ ] Adds a runtime dependency
- [ ] Removes a dependency
- [x] Changes an envelope schema (new `freelo.tasks.create/v1`)
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
New user-visible command and a brand-new envelope schema (additive) — both Yellow signals. No Red triggers: no `src/config/`, no auth, no HTTP-client defaults, no breaking changes, no dep removal/major-bump. The shared write helpers (`dry-run`, `batch`, NDJSON streamer) are pure utility modules under `src/lib/`, no auth or client work. Risk-tier definition: open the PR and stop before merge for human review.

## Open concerns
- The spec must decide whether `--editor` is in scope for R09 or deferred to R15 (description set). Default position: defer to R15 so this slice doesn't take on terminal-editor I/O. Decide & log.
- The spec must verify the Freelo OpenAPI shape for `POST /project/{project_id}/tasklist/{tasklist_id}/tasks` — request body, label association mechanics (string vs id), priority vocabulary, response shape. If the API doc doesn't answer, pause.
- `--label` semantics: roadmap says `--label <name>...` repeatable. The spec must check whether the create-task endpoint accepts inline labels or whether labels are a follow-up POST (R10 already references `task-labels/add-to-task` for edit). If create requires post-creation label association, the spec must spell out the order and the failure handling.
- Body builder pattern for the POST — design a reusable `build*Body` shape so R10 (edit) and R12 (move) can borrow it.

## Recommended branch name
feat/tasks-create
