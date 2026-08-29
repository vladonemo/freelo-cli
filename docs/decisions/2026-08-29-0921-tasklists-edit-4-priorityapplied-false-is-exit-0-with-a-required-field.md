# Decision 4 — `priorityApplied: false` surfaces as exit 0 with a required machine-readable field, not a non-zero exit

**Run:** 2026-08-29-0921-tasklists-edit
**Phase:** 2 (spec)
**Agent:** orchestrator (inline)

**Question:** When `POST /tasklist/{id}/edit` returns `200 {priorityApplied: false}` — meaning name/budget/time-budget/followers/worker all committed but the priority reorder did not — should `freelo tasklists edit` exit 0 with a notice, or exit non-zero?

**Decision:** **Exit 0.** Emit the normal success envelope with three reinforcing signals:

1. `data.priority_applied: boolean` — **always present, non-optional**, mirroring the OpenAPI `required: [priorityApplied]`. This is the primary machine-readable contract.
2. `data.priority_requested: boolean` — lets an agent distinguish "`true` because the reorder worked" from "`true` because no reorder was asked for". The API conflates these (`true` when "not requested"); the CLI does not.
3. `notice` on the envelope (and a distinct warning line in human mode) **only** when `priority_requested && !priority_applied`, naming the exact retry command.

**Alternatives considered:**

- **(A) Non-zero exit, reusing the list-commands' partial-result pattern** — `src/commands/comments/list.ts:398-411` (and the same block in `files/list.ts`, `notifications/list.ts`, `projects/list.ts`, `reports/list.ts`, `subtasks/list.ts`) already writes a partial envelope to stdout and *then* re-throws, producing a non-zero exit. This is a real in-repo precedent for "part of what you asked for didn't happen".
- **(B) A new global exit code (e.g. `7` = partial success).** `architecture.md:339` says adding a code is a minor change, so it was available.
- **(C) A `--strict-priority` opt-in flag** making the failure non-zero on demand, exit 0 by default.
- **(D) Exit 0 with only a prose `notice`** — the roadmap's suggestion, mirroring R10 decision 11 (spec 0020, refresh-GET-failed).

**Rationale:**

The roadmap proposed (D) by analogy to R10 d11, but that analogy is **weak**: in R10 the requested *mutation* fully succeeded and only a secondary read-back failed. Here a mutation the user explicitly requested did **not** happen. So (D)'s precedent does not actually cover this case, and a bare prose `notice` is not a contract an agent can branch on. The repo has a second, better-fitting precedent — (A) — which initially looked correct.

(A) was nevertheless rejected on a harm argument specific to *this* command. The OpenAPI text says the client "may retry the priority update **separately**". A non-zero exit signals "this command failed", and the natural agent recovery for that is to retry the **whole invocation**. On this command the whole invocation can carry `--should-change-existing-tasks`, whose documented effect is to propagate a follower change to **every existing task in the tasklist**. A non-zero exit would therefore actively steer agents toward re-firing the widest blast-radius side effect in the slice, to recover from a failure that touched none of it. That is worse than the problem it solves. The list-partial precedent has no such hazard — re-reading a list is free and idempotent — which is exactly why it can afford a non-zero exit and this command cannot.

(A) has a second, independent defect: exit 4 is defined as "API error (4xx/5xx from Freelo)" (`architecture.md:49-56`), and this is a documented, expected **200**. Reporting exit 4 would misdescribe the HTTP layer and collide with genuine API-failure handling. And the `freelo.error/v1` envelope has no `data` field (`src/ui/envelope.ts:37-49`), so any error-shaped exit would **destroy** the partial-success information — the agent would lose the ability to tell which fields landed.

(B) was rejected as disproportionate: a new global exit code introduced by one command for one boolean, which agents would have to learn specifically anyway — so it buys nothing over reading `data.priority_applied`, while permanently widening a global contract.

(C) was rejected as scope creep: a flag whose only job is to relitigate this decision at call time, doubling the tested surface for a case the envelope already expresses precisely.

The residual risk of exit 0 is the agent that checks only the exit code and never reads stdout. That agent is out of contract with this CLI generally: `CLAUDE.md` makes the versioned envelope the agent interface ("Output defaults to JSON when non-TTY… Envelope schemas are a public contract"), and exit 0 already covers "no results" and "idempotent no-op" — outcomes that likewise require reading the payload to interpret. Making `priority_applied` **required rather than optional** is the mitigation: it is present on every single response, so an agent that reads `data` at all cannot miss it by absence.

**Consequence for the schema contract:** `priority_applied` and `priority_requested` are required fields of `freelo.tasklists.edit/v1` from v1. Adding them later would have been a minor bump; making them required now costs nothing and avoids an optional-field footgun.
