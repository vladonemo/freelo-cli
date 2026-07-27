## Paused at Spec (before Plan / Implement)

**Run:** 2026-07-27-1211-tasks-edit-validation
**Reason:** The real `POST /task/{id}` response body is undocumented and uncaptured; any response schema written for it now would be invented, and the one fix that avoids inventing it inverts a deliberate, tested error contract.
**Risk tier:** Red

### What happened

Static analysis narrowed issue #105 substantially — further than the issue itself did —
but stopped short of a root cause. Two findings matter.

**(a) Hypotheses 2-6 are eliminated.** `tasks edit` already performs the exact control
the issue proposes. `src/commands/tasks/edit.ts:331` runs an unconditional lookup
`GET /task/{id}` — same task, same `TaskDetailSchema`, no try/catch — *before* the POST.
Had any shared task-detail field diverged (stringified ids, bare-string `state`,
`labels[]` without `uuid`, out-of-enum `priority_enum`, partial `cost`), that GET would
have thrown first and the message would have said `GET`, not `POST`. So the divergence is
POST-specific: **issue hypothesis 1**.

**(b) The payload we hard-fail on is never used.** `editTask()`'s single caller reads only
`result.raw.rateLimit`; `result.task` has zero readers in `src/` and `test/`. The
envelope's `data.task` comes from the separate refresh GET at :396. The command fails
strict validation on a body it discards.

What remains unknown is *what the POST actually returns*. `docs/api/freelo-api.yaml:1713`
claims "same shape as `GET /task/{id}`" — which finding (a) contradicts — and no fixture
in the repo captures a real response. With `allowNetwork = false` I cannot observe it.

A compounding problem: the issue's own instruction ("re-run with `-vv` and paste
`rawBody`") **cannot work today**. `FreeloApiError.rawBody` is populated and scrubbed
(`src/errors/freelo-api-error.ts:40`) but never emitted — the error envelope omits it
(`src/errors/handle.ts:21-41`), `FREELO_DEBUG=1` prints only the stack (`:188`), and the
HTTP client logs no response bodies at any level. That is why the body is still
uncaptured after the issue was filed.

### Evidence

- `src/commands/tasks/edit.ts:331` — unconditional pre-POST lookup GET (the control)
- `src/commands/tasks/edit.ts:384-390` — `result.task` discarded; only `rateLimit` read
- `src/api/tasks-edit.ts:77,89-99` — `EditTaskResult.task`, zero readers repo-wide
- `src/api/client.ts:240-250` — throw site; zod paths land in `message`, values do not
- `src/errors/handle.ts:21-41,182-190` — `rawBody` absent from both output branches
- `docs/api/freelo-api.yaml:1713,1756-1762` — asserts the shape our evidence contradicts
- `test/commands/tasks/edit.test.ts:930-948` — `editMalformed` → `expect(exitCode).toBe(4)`, the tested contract any relaxation must invert
- `test/msw/handlers.ts:980` + `test/fixtures/tasks/edit-9012-detail.json` — self-authored, circular; not API truth

### Decision needed

The bug is one observation away from a one-line fix. Which path do you want?

Options:

  **A. Capture the body first (recommended).** Run one command against a real task and
  paste the result; I resume with a fixture-backed, non-speculative fix and a verbatim
  regression test. Cost: ~1 minute of your time. This is the only option that ends with
  us actually knowing the contract. If you can't easily grab it, pick A2.

  **A2. Ship the diagnostics fix first, then capture.** Surface `rawBody` on
  `VALIDATION_ERROR` under `FREELO_DEBUG=1` / `-vv` (scrubbed, opt-in, never on by
  default) so this class of bug is self-diagnosing forever. Standalone-valuable, but it
  touches `src/api/client.ts` + `src/errors/` (Red), needs a `freelo.error/v1` decision
  (add a field vs. stderr-only, since adding one is an envelope change), and needs a
  security pass — dumping arbitrary API bodies is a real PII/secret surface. Does not fix
  #105 by itself.

  **B. Relax the unused POST payload without capturing.** Validate the POST response as
  an opaque acknowledgement; keep the refresh GET as the sole strictly-validated source of
  task state. Fixes #105 under all six hypotheses, no API guessing, `patch` changeset.
  Tradeoff: inverts the tested exit-4 contract, permanently forfeits learning the real
  shape, and sets a "don't validate what you don't read" precedent against CLAUDE.md.

  **C. Widen `TaskDetailSchema`'s suspect fields.** I recommend against this and did not
  do it — finding (a) says those fields aren't implicated, and the schema also backs
  `tasks show` / `tasks move` / the refresh GET. Listed only for completeness.

  **D. Abort the run.**

My recommendation: **A**, falling back to **B** if the body can't be obtained soon —
B is defensible on architecture alone, and A2 can follow separately.

### Resume with

```
/resume 2026-07-27-1211-tasks-edit-validation A
```

For option A, the capture command — this hits the network, so it is yours to run, not
mine (`allowNetwork = false` for this run). Use a throwaway task:

```bash
# replace <id>; prints the raw POST response without any CLI schema validation
curl -s -u "$FREELO_EMAIL:$FREELO_API_KEY" \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json' \
  -X POST "https://api.freelo.io/v1/task/<id>" \
  -d '{"name":"scratch rename probe"}' | tee /tmp/task-edit-response.json
```

Paste the output (or the file) with the resume. Scrub anything sensitive — I only need
the **shape**; field values can be redacted as long as their JSON types survive.
