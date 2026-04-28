# Decision 7 — No status follow-up on the no-active-session 409

**Run:** 2026-04-28-2100-r20-time-stop-edit
**Phase:** spec
**Agent:** orchestrator (architect role)

**Question:** R19's start-409 rewriter does an opportunistic `GET /timetracking/status` to enrich the hint. Should stop-409 / edit-409 do the same?
**Decision:** No. The hint says "no session is running" — there's nothing useful to enrich with.
**Alternatives considered:**
- Always do a status follow-up for symmetry — rejected; one extra network call with no value-add.
**Rationale:** YAGNI. R19's follow-up exists because the start hint *needs* current-session details ("you're tracking #X since Y"). Here the hint is "you have nothing"; that's all the info needed.
