# Phase 1 — Triage

**Status:** complete
**Output:** `docs/runs/2026-08-24-1759-fix-tasklist-task-order/triage.md`
**Result:** tier **Red**, type `fix`, branch `fix/tasklist-task-order`

Two Red triggers: (1) the cached OpenAPI contract contradicts the field report, making the API
behavior effectively not-covered → *"don't guess the API"*; (2) the change alters the default
observable output of an already-released command.

Not a pause-at-triage Red — the requirement itself is unambiguous, so the run proceeds to spec and
plan and pauses at the implement gate (decision 1).

Five open concerns handed to the architect: narrow blast radius, MSW structurally can't reproduce
the bug, `TaskSummary` carries no ordering field, hypothesis 3 is unfalsifiable offline, and the
`applied_filters` echo question.
