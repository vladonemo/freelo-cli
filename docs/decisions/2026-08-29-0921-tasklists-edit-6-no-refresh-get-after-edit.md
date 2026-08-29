# Decision 6 — No post-edit refresh GET; echo `applied_changes` instead

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** R10 (`tasks edit`) follows its write with a refresh `GET` so the envelope returns the updated entity. Should `tasklists edit` do the same?

**Decision:** **No.** One HTTP call total. `data.applied_changes` echoes the wire body that was sent; `data` carries no tasklist entity.

**Alternatives considered:**

- Refresh via `GET /tasklist/{id}` and embed `TasklistDetail`, inheriting R10 decision 11's "refresh failed" notice path.
- Refresh via `GET /all-tasklists?projects_ids[]=...` filtered to the one id, to get `TasklistFull` (which does carry `budget`).

**Rationale:** The edit response documents exactly one field, `priorityApplied` — there is no entity to return. And `GET /tasklist/{id}` returns `TasklistDetail`, which per `src/api/schemas/tasklist.ts:113-116` does **not** carry `budget`, `real_cost`, `state`, or `real_minutes_spent`. So a refresh GET would fail to confirm the single most interesting thing this command changes (the budget), while adding a second network round-trip, a second failure mode, and the whole R10-d11 refresh-failure notice branch. It would cost a call and a code path to return *less* information than the echo does.

The `/all-tasklists` variant would return `TasklistFull` (which has `budget`), but it is a paginated cross-project list endpoint being abused as a single-resource read, and reordering via `--priority` makes its paging position unstable — a poor trade for the same goal.

`applied_changes` is not a guess: it is the literal body the CLI sent on a request the server answered `200` to, and the OpenAPI states the non-priority fields commit transactionally. So for every field except `priority` it is an accurate record of what landed — and `priority` has its own dedicated `priority_applied` flag (decision 4). Precedent: `applied_changes` is R10's own shape (`src/commands/tasks/edit.ts:360-364`).

**Consequence:** users wanting to see post-edit state run `freelo tasklists show <id>`, which is what that command is for. Documented on the command docs page.

**Bonus:** this also removes the entire class of bug that R10 decision 11 exists to paper over. With no refresh GET there is no refresh failure, so the only `notice` this command can emit is the `priority_applied` one — keeping the envelope's `notice` channel unambiguous.
