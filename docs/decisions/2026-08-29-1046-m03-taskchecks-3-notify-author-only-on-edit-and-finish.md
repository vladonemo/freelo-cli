# Decision 3 — `--notify-author` is exposed on `edit` and `finish` only

**Run:** 2026-08-29-1046-m03-taskchecks
**Phase:** spec
**Agent:** orchestrator (architect mandate)

**Question:** The requirement and `docs/roadmap-migration-2026-08.md:103` both state that all four taskcheck endpoints accept `notify_author` and recommend a shared `--notify-author` flag. The OpenAPI contract disagrees. Which wins, and what does the CLI expose?

**Decision:** The OpenAPI contract wins. `--notify-author` is offered on `freelo taskchecks edit` and `freelo taskchecks finish`. It is **not** offered on `delete` or `reopen`, whose wire calls send no body at all.

Evidence, `docs/api/freelo-api.yaml`:

- `editTaskcheck` :2128-2148 — `requestBody: required: true`, includes `notify_author`.
- `deleteTaskcheck` :2156-2171 — **no `requestBody` key**.
- `finishTaskcheck` :2183-2197 — `requestBody: required: false`, includes `notify_author`.
- `activateTaskcheck` :2206-2222 — **no `requestBody` key**.

**Alternatives considered:**

- **Expose it on all four and send it anyway.** Rejected: sending an undocumented body to `DELETE /taskcheck/{id}` and `POST /taskcheck/{id}/activate` is guessing at API behavior, which the orchestrator's hard rules forbid outright. It could be ignored, or 400, and the yaml does not say.
- **Expose it on all four but silently no-op on two.** Rejected: a flag that accepts input and does nothing is worse than an absent flag — it tells an agent a notification preference was honored when it was not.
- **Pause and ask the human.** Considered seriously, since this narrows a user-visible surface relative to the stated CLI shape. Rejected because the requirement explicitly instructed "verify each against `docs/api/freelo-api.yaml` directly — don't take this summary on faith" and `autonomous-sdlc.md` §Failure modes states "Spec says something the OpenAPI spec contradicts → Freelo's contract is authoritative". Verification was the assignment; the discrepancy is its expected product, not an ambiguity. Flagged in the PR body for human review.

**Rationale:** The pinned OpenAPI document is the contract of record, and two of the four operations declare no request body whatsoever. Two subcommands carrying the flag and two not is a visible asymmetry, so both the help text and `docs/commands/taskchecks.md` state why, citing the yaml lines.
