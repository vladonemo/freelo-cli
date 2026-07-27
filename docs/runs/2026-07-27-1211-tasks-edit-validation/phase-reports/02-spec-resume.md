# Resume — 2026-07-27 12:53

**Paused at:** Spec (before Plan / Implement)

**Question:** Which path to take on issue #105, given the real `POST /task/{id}` response
body was undocumented and uncaptured? Options were A (capture the body first), A2 (ship
diagnostics first), B (treat the unused POST payload as an opaque ack), C (widen
`TaskDetailSchema`), D (abort).

**Answer:** Option **A** — the human ran the capture against task `18579501` and supplied
the verbatim `POST /task/18579501` response body for `{"name":"scratch rename probe"}`.

**Interpretation:** The captured body was validated against the current
`TaskDetailSchema` before re-entering any phase. **It parses cleanly.** Option A's premise
— that the capture would pin an offending field and reduce the fix to a fixture-backed
one-liner — is refuted by the capture itself. There is no schema defect to fix on this
evidence, so the run does **not** re-enter Plan/Implement. The pause is re-raised with a
corrected evidence base and a narrower ask.

---

## What the capture proves

Probe: the captured body (comment bodies and user names redacted; every JSON *type* and
the full key set preserved) run through `TaskDetailSchema.safeParse`.

```
VALIDATES: yes
```

Consequences, in order of importance:

1. **Hypothesis 1 is dead.** The `POST /task/{id}` response *is* a bare `TaskDetail` —
   not `{result:"success"}`, not `{task:{...}}`. `docs/api/freelo-api.yaml:1713` is
   correct as written; the previous triage's finding (a), which inferred a POST-specific
   divergence, drew the right conclusion from the wrong premise.
2. **Hypotheses 2–6 are dead on this body.** `cost.amount` arrived as the string `"0"`
   (already absorbed by `CurrencySchema`), `priority_enum` as `null` (already
   `.nullable()`), `state` as a full `{id, state}` object, `labels[0]` with its `uuid`,
   ids as numbers throughout.
3. **The write path works.** The POST renamed the task and echoed
   `"name":"scratch rename probe"`. Freelo accepted `{"name": ...}` — exactly what
   `buildEditTaskBody` emits for `--name` (`src/api/tasks-edit.ts:34`).
4. **Two unknown-to-schema keys rode through `.passthrough()` harmlessly**:
   `finished_by` and the `tracking_users` entries. Neither is declared; neither breaks.

## What the capture does not prove

The capture came from `curl`, against task `18579501`, **after** the issue was filed. It
does not establish that the CLI still fails on that task, nor that `18579501` is the task
the reporter was editing when the bug was observed.

Critically, re-reading the issue: the error string is quoted as being *"of the form"*
`Unexpected response shape from POST /task/<id>` and the issue explicitly states the
exact zod issue list "has not been captured yet." **The word `POST` in that message is
therefore the reporter's reconstruction, not a captured string.** The prior triage leaned
on it to eliminate hypotheses 2–6 — reasoning that a shared field divergence would have
thrown on the unconditional pre-POST lookup GET (`src/commands/tasks/edit.ts:331`,
verified still unconditional on the live path) and so reported `GET`. That reasoning is
sound *given* the message, but the message is unverified. If the real error said `GET`,
hypotheses 2–6 return in full — pointing at some *other* task whose detail shape diverges,
not at the edit path at all.

## Corrected ask

Neither a schema change nor the option-B relaxation is justified on current evidence.
What is still missing is small and specific:

1. The **task id** that actually failed (may not be `18579501`).
2. The **verbatim** error string from the CLI — in particular whether it says `GET` or
   `POST`, and the zod issue list.

Re-running `freelo tasks edit 18579501 --name "..."` against the live API answers both:
it either reproduces (live repro, capture the string) or it does not (the failing task is
a different one, and its id is the ask).

## Fixture hygiene note (binding on whoever implements)

The captured body carries real client-conversation content in `comments[].content`
(Slovak/Czech project discussion, a live domain, third-party names) and real user ids and
full names in `author` / `tracking_users`. CLAUDE.md forbids secrets in fixtures and this
is adjacent personal data. **Any fixture derived from this capture must be redacted** —
substitute placeholder strings and synthetic ids, preserving only JSON types and the key
set. The unredacted body must not land in `test/fixtures/`.

## Run state after resume

No phase re-entered. No `src/` or `test/` change. The run remains paused at Spec; see
`pause.md` for the original options, corrected by this report.
