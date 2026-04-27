# Phase report — Plan

**Run:** 2026-04-27-0535-tasks-show
**Phase:** Plan (architect, appended to spec)
**Status:** Complete (recovered from prior session)

## Outputs

- `docs/specs/0018-tasks-show.md` §8 — Plan section.
  - §8.1 Files to add (10).
  - §8.2 Files to modify (6).
  - §8.3 Test plan (≥85% branch coverage on `src/commands/**`).
  - §8.4 Commit slicing (two commits).
  - §8.5 Acceptance criteria.
  - §8.6 Risks and mitigations.
  - §8.7 Out of scope (re-stated for /implement).

## Dependencies

Zero new dependencies. All required infra (`fetchAllPages`,
`normalizePaginated`, `buildEnvelope`, `renderAsync`,
`handleTopLevelError`, `parseTaskId`-style validators) already shipped
in R03–R07.

```
ARCHITECT phase=plan run=2026-04-27-0535-tasks-show status=ok files=16 commits=2 new_deps=0
```
