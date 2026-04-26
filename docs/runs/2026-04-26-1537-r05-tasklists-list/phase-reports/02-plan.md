# Phase 2 — Plan

**Run:** 2026-04-26-1537-r05-tasklists-list
**Phase:** plan
**Agent:** orchestrator (architect role)
**Status:** ok

---

## What was produced

Appended `## 8. Plan` to `docs/specs/0014-tasklists-list.md`. The plan covers:

- 11 new files + 5 modified files. New deps: 0.
- Test strategy: 26 vitest cases (9 happy path, 11 validation errors with exit-code asserts, 6 HTTP error paths). Coverage targets per Calibration §2/§4.
- 4-commit slicing (api → commands+README → tests → docs+changeset). Each commit independently passes the five-gate (`typecheck && lint && test && build && check:readme`).
- Definition-of-done checklist with branch-protection awareness.

## Key planning decisions

1. **README regeneration lives in C2, not C3.** First draft of slicing ran `pnpm fix:readme` after tests landed, which would have left C2 with a red `check:readme` gate. Corrected to bundle the regenerated README with the bin registration (C2).
2. **No standalone schema test file.** Round-trip validation happens through the integration tests' `parseFirstJson` flow, mirroring R03's posture. Avoids 50+ lines of low-value scaffolding.
3. **No spinner.** R03 deferred lazy `ora` wiring; R05 inherits that decision. The deferral is documented in spec §6.

## Risks called out

- **`meta.outputSchema` literal-type fit with `attachMeta`** — likely the only typecheck risk in C2. Mitigation: use `as const` per R03's `src/commands/projects/list.ts:33-36` shape.
- **Coverage regression from the new `try/catch` in `--all` driver** — Calibration §4 trigger. Mitigation: tests #24 (first-page error) and #25 (mid-stream error) cover both arms.

## Plan size

~190 lines added to spec §8. Within the "small reuse slice" budget called out at the top of the spec.

## Next phase

Phase 3 — Implement. The implementer agent will execute commits C1-C4 against the plan. No pause anticipated; spec is internally consistent and all 7 OQs are resolved.
