# 0059 — `tasks edit` fails on `POST /task/{id}` response validation

**Status:** Blocked — open questions unresolvable without a captured response body
**Run:** 2026-07-27-1211-tasks-edit-validation
**Issue:** #105
**Type:** fix

---

## 1. Problem

`freelo tasks edit <id> --name "<new name>"` exits 4 with

```
Unexpected response shape from POST /task/<id>: <zod issues>
```

The rename may or may not have been applied server-side (the CLI cannot tell — it fails
after the write, on the way back in). The user gets a failure envelope for what is
plausibly a successful mutation. That ambiguity is the worst part of the bug: it is not
safe to retry blindly, and not safe to assume success.

## 2. Evidence gathered (offline)

Full detail in `docs/runs/2026-07-27-1211-tasks-edit-validation/triage.md`. Summary:

| # | Finding | Confidence |
|---|---|---|
| 1 | The pre-POST lookup `GET /task/{id}` (`src/commands/tasks/edit.ts:331`, same schema, same task, no try/catch) must have passed → the divergence is POST-specific (issue hypothesis 1); hypotheses 2-6 eliminated | High, but rests on an error string the issue says was not captured verbatim |
| 2 | `editTask()`'s parsed `TaskDetail` is never consumed — the only field read is `result.raw.rateLimit`; `data.task` comes from the refresh GET | Certain |
| 3 | No captured real POST response exists in the repo; fixtures are self-authored and circular | Certain |
| 4 | The strict behavior is deliberate and tested (`edit.test.ts:930-948`, exit 4) | Certain |
| 5 | `rawBody` is captured on the error but never emitted in any output mode → the issue's own capture instruction is not executable | Certain |

## 3. API surface

- `POST /task/{task_id}` — `docs/api/freelo-api.yaml:1690-1762`. Declares the 200 response
  as `#/components/schemas/TaskDetail` (`:1756-1762`) and states at `:1713` *"The endpoint
  responds with the task's full detail (same shape as `GET /task/{id}`)."*
- `GET /task/{task_id}` — `:1662-1689`, same `TaskDetail`.

Finding 1 contradicts `:1713`. Per `.claude/docs/autonomous-sdlc.md:248` the Freelo
contract is authoritative and a contradiction is a pause, not a unilateral correction —
especially since we cannot substitute a *correct* description, only delete a wrong one.

## 4. Non-goals

- Widening `TaskDetailSchema` fields (`state`, `labels[].uuid`, `priority_enum`, `cost`,
  id types) to make the symptom disappear. Findings 1-2 show these are not implicated,
  and `TaskDetailSchema` backs `tasks show`, `tasks move`, and the refresh GET — a
  speculative widening degrades validation on three working commands to chase a bug in a
  fourth.
- Any `z.unknown()` bypass on a payload that feeds business logic (CLAUDE.md).

## 5. Open questions (blocking)

### OQ-1 — What does `POST /task/{id}` actually return?

Unresolvable offline. `docs/api/freelo-api.yaml` asserts `TaskDetail`; the evidence says
otherwise; nothing in the repo records the real body. Any schema written for this
endpoint today is invention.

**Resolvable by the human in one command** — see `pause.md` §Resume.

### OQ-2 — Should `editTask` validate a payload it discards?

Finding 2 makes a strong architectural case for treating the POST response as an opaque
acknowledgement (HTTP status = success signal; rate-limit headers = the only payload we
read) and letting the already-present refresh GET remain the sole strictly-validated
source of task state.

This is defensible **without** knowing the body and fixes the bug under all six
hypotheses. But it is a deliberate behavior change:

- inverts the tested contract at `edit.test.ts:930-948`;
- permanently forfeits the chance to learn what the endpoint returns;
- sets precedent for "don't validate what you don't read", which cuts against
  CLAUDE.md's "every network call is schema-validated".

That is a maintainer call, not an orchestrator call.

## 6. Plan

Deliberately not written. Producing a plan requires resolving OQ-1 or OQ-2 first; the
plan is the contract and a plan built on an invented response shape is worse than none.

## 7. Test strategy (once unblocked)

- Regression test in the R10 `tasks edit` MSW suite (`test/commands/tasks/edit.test.ts`)
  with a handler returning the **real** captured body verbatim, per the run's process
  requirements.
- Preserve or consciously re-baseline the `editMalformed` → exit 4 row (calibration §2:
  the exit code is a public contract).
- If the diagnostics option is chosen: a test per new branch (calibration §4), plus a
  secrets-scrubbing test, plus an assertion that the body is absent by default.
