# Triage — 2026-07-27-1211-tasks-edit-validation

**Tier: Red**
**Route flags:** `needsSecurityReview: false` (revisit if the diagnostics option is
chosen — it would print API response bodies), `requiresFreeloApi: true`,
`preApprovedDeps: []`
**Outcome: Pause before implementation.**

---

## Tier rationale

Red on three independent triggers from `.claude/docs/autonomous-sdlc.md`:

| Trigger (autonomous-sdlc.md) | How it fires here |
|---|---|
| :132 "API behavior not in `docs/api/freelo-api.yaml` → Pause (don't guess the API)" | The actual `POST /task/{id}` response body is unknown and undocumented. The YAML asserts a shape that the evidence below contradicts. |
| :248 "Spec says something the OpenAPI spec contradicts → Pause — Freelo's contract is authoritative" | `freelo-api.yaml:1713` and `:1756-1762` claim the POST returns `TaskDetail`. Our analysis shows it does not. |
| :71 "Touches `src/api/client.ts`" | Every viable fix path (diagnostics, or validation-semantics change) lands in `src/api/client.ts` or changes a tested error contract. |
| :75 "Spec has unresolvable Open questions" | Two open questions remain unresolvable offline (see spec). |

Highest tier wins → **Red**.

---

## What IS derivable (no network, no guessing)

### Finding 1 — hypotheses 2-6 are effectively eliminated by a control the issue missed

`src/commands/tasks/edit.ts:331` runs an **unconditional lookup `GET /task/{id}`
before the POST**, on the same task id, through the **same `TaskDetailSchema`**:

```ts
// src/commands/tasks/edit.ts:328-333
// ---- Lookup: fetch the task to derive tasklist_id / project_id.
const lookup = await getTaskDetail(client, taskId, { ... });
```

It is **not** wrapped in try/catch (the refresh GET at :396 is; this one is not). If the
task's persistent field shapes diverged from `TaskDetailSchema` — hypothesis 2
(stringified ids), 3 (`state` as bare string), 4 (`labels[]` missing `uuid`),
5 (`priority_enum` outside `l|m|h`), or 6 (partial/foreign `cost`) — this GET would
throw **first**, and the user's error would read:

    Unexpected response shape from GET /task/<id>: ...

The reported error says **POST**. Therefore the GET on that exact task validated
cleanly moments earlier, and the divergence is specific to the POST response — i.e.
**hypothesis 1**.

This also answers the issue's own suggested triage step ("run `freelo tasks show <id>`
on the same task") **statically**: `tasks edit` already performs that exact GET on every
live invocation, and it passed.

**Caveat that keeps this from being conclusive:** the issue states the error was not
captured verbatim ("the exact zod issue list from the failing run has not been captured
yet"). The whole inference rests on the word `POST` in a paraphrased message. Confidence
is high but not certain.

### Finding 2 — the strictly-validated POST payload is never consumed

`editTask()` has exactly one caller, and it discards the parsed task:

```ts
// src/commands/tasks/edit.ts:384-390
const result = await editTask(client, { taskId, body: editBody, ... });
accumulator.edit = editBody as Record<string, unknown>;
lastRateLimit = result.raw.rateLimit;      // <- only field read
```

`result.task` has **zero readers** in `src/` and **zero** in `test/`
(`EditTaskResult.task` is referenced only by its own declaration at
`src/api/tasks-edit.ts:77`). The envelope's `data.task` comes from the **refresh GET** at
`src/commands/tasks/edit.ts:396-401`, which is separately validated through
`TaskDetailSchema`.

So the command hard-fails on strict validation of a body whose content it throws away.

### Finding 3 — the repo contains no captured real POST response

`test/fixtures/tasks/edit-9012-detail.json` was authored by us to satisfy our own
schema; `tasksEditHandlers.ok(taskId, body)` (`test/msw/handlers.ts:980`) echoes whatever
the test supplies. This is circular evidence, not API truth. Nothing in the repo records
what Freelo actually returns from `POST /task/{id}`.

### Finding 4 — the current strictness is deliberate and tested

`test/commands/tasks/edit.test.ts:930-948` (`editMalformed` → `expect(exitCode).toBe(4)`)
asserts that a POST response failing `TaskDetailSchema` exits 4. Relaxing `editTask`'s
schema means inverting an intentional, tested contract — a behavior change, not a
bug fix.

### Finding 5 — the issue's own remediation instruction is not executable

The issue says: *"re-run with `-vv` (or `FREELO_DEBUG=1`) and paste the full error +
`rawBody`."* That cannot work today:

- `FreeloApiError.rawBody` is populated and scrubbed (`src/errors/freelo-api-error.ts:40`)
  but is **never emitted**. `buildErrorEnvelopeInternal`
  (`src/errors/handle.ts:21-41`) omits it; the human branch (`:182-190`) prints only
  `message`, `hintNext`, and — under `FREELO_DEBUG=1` — the **stack**, not the body.
- `HttpClient` never logs response bodies at any level; `-vv` (pino debug) yields nothing
  for a 2xx-with-bad-shape.
- The zod issue list *is* interpolated into `message` at `src/api/client.ts:243`, so paths
  are visible — but the offending **values** are not.

This is why the body is still uncaptured, and it is the real blocker to root-causing.

---

## What is NOT derivable

Knowing *that* the POST response differs from the GET does not reveal *what it is*.
Candidates all remain open: `{ result: "success" }`, `{ task: {...} }`, `{ data: {...} }`,
`{}`, or a differently-serialized detail. `docs/api/freelo-api.yaml` states the opposite
of our conclusion, so it cannot arbitrate. **Writing a response schema for this endpoint
would be invention.**

The `MinutesSchema` / `CurrencySchema.amount` union-and-coerce precedent does not
transfer: those widenings were each anchored to an *observed* concrete divergence
(`"130"` vs `130`). Here there is no observation to anchor to — applying the pattern
would mean picking a hypothesis and hoping.

---

## Decision

Pause. The narrowing above is real and valuable, but every remaining step requires either
inventing an API contract or silently changing a tested error contract. Both are explicit
pause triggers. See `pause.md` for the options put to the human.
