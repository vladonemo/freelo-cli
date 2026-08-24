# Resume — 2026-08-24T17:32:00+02:00

**Paused at:** Phase 4 — Implement (before any source edit)
**Question:** Do we spend one live API request to learn what this endpoint actually does, or ship the determinism-only change blind? (Options A / B / B′ / C — see `pause.md`)
**Answer:** A. Verbatim from the human (via Discord DM, relayed through the coordinating session):

> Live verification complete against a dedicated test account (project 628608 / tasklist 1985928, key already rotated by the human after use). Findings:
>
> 1. `no order_by` and `order_by=priority` returned byte-identical task order, both before and after a manual drag-reorder performed live in the Freelo web UI by the human.
> 2. After the human dragged task 32014124 ("Break bigger tasks into smaller subtasks") to the top of the board, both `no order_by` and `order_by=priority` re-fetches reflected the new position identically (task moved from index 3 to index 0 in both responses).
> 3. This confirms `order_by=priority` on `GET /project/{p}/tasklist/{t}/tasks` IS the manual/drag board order — hypothesis 3 (priority = L/M/H task priority, not manual order) is refuted. The OpenAPI doc's stated default (`priority`) is accurate; hypothesis 1 (live default silently diverges to date_add) is also refuted — the live default really is priority today.
> 4. `order_by=date_add` produced a genuinely different, distinct ordering in both live pulls — confirms date_add sorting works as a separate, distinct thing server-side.
>
> Decision: proceed with the plan's fix — have the CLI explicitly send `order_by=priority&order=asc` as the default on the tasklist-tasks route whenever the caller doesn't pass `--order-by`/`--order`. This is now a confirmed correctness fix, since order_by=priority is proven to track manual board order.
>
> Also update `docs/api/freelo-api.yaml`'s `order_by` parameter on this endpoint to document that `priority` corresponds to the tasklist's manual/drag-and-drop task order — the 4th evidence-backed doc-vs-reality gap this project has found.
>
> Non-blocking follow-up note for the PR/issue, out of scope for this fix: the bug only reproduces on the exact route `/project/{p}/tasklist/{t}/tasks` (both `--project` and `--tasklist`, no other filters). Any other invocation shape falls through to `/all-tasks`, which defaults to `date_add` and has no concept of manual order — this routing behavior may be the actual mechanism behind the originally reported symptom. Do not change routing behavior as part of this run.
>
> `allowNetwork` reverts to `false` for the remainder of this run — the one live check needed is complete.

**Interpretation:** Option A, fully resolved. OQ-1/OQ-2/OQ-3 from spec §11 are answered by the live experiment (run outside this orchestrator invocation, by the coordinating session using human-supplied dedicated-test-account credentials — no code in this repo made the calls; this is the "you" in spec §11's instructions):

- OQ-1 (what does no-`order_by` return) → identical to `order_by=priority`.
- OQ-2 (what does `order_by=priority` sort by) → manual/drag board order, not L/M/H `priority_enum` buckets.
- OQ-3 (does any `order_by` value yield board order) → yes, `priority`.

Re-enter at phase 4 (Implement) and proceed through the remaining pipeline (implement → test → review → doc → commit/push/PR → risk-tier gate) per the plan in `docs/specs/0060-tasklist-task-order.md`, using option A's resolution:

1. `getTasklistActiveTasks` (`src/api/tasks.ts:128-152`) defaults `order_by`/`order` to `'priority'`/`'asc'` when the caller supplies neither, per spec's option-A branch (decision 3's §8a/§8b and TODO-4 sub-questions are moot under A — they were B/B′-only concerns).
2. Update `docs/api/freelo-api.yaml:1381-1386`'s `order_by` parameter with a `description` documenting that `priority` is the tasklist's manual/drag-and-drop task order, grounded in the live evidence above (no raw response body or credentials to include — the test account's data is disposable onboarding-template content, and the API key has already been rotated by the human).
3. Changeset and PR body: this **fixes #108** (not a determinism-only hedge — option A confirmed the semantic correctness of the fix).
4. Non-blocking note for the PR description, not implemented as a code change: the `/all-tasks` routing-fallback observation above.
5. `allowNetwork` is `false` again for the rest of this run — no further live API calls.
