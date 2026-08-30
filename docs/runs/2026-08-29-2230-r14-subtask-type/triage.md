# Triage — 2026-08-29-2230-r14-subtask-type

**Tier: Red**

## Rationale

Two independent Red triggers from `.claude/docs/autonomous-sdlc.md`:

1. **"Breaking behavior of an existing command" -> Pause.** Retiring `inferStorageForm` in
   favour of `Subtask.type` changes the value of `data.storage_form` in the shipped
   `freelo.subtasks.add/v1` envelope for the same server state, and can flip
   `data.input_ignored` between present and absent. `input_ignored` is the signal an agent
   acts on ("your `--worker` was discarded"), so the flip reverses a claim about whether a
   write took effect. The human renderer (`src/ui/human/subtasks-add.ts:35-44`) branches on
   the same field, so TTY output changes too.

2. **"API behavior not in `docs/api/freelo-api.yaml` -> Pause (don't guess the API)."** The
   yaml declares `type` and its enum, but does not answer the two questions the change
   depends on: (a) does the smart->simple fallback path on `POST /task/{id}/subtasks`
   actually set `type: 'taskcheck'`, and (b) what are the real `task_id` semantics (see the
   contradiction in the spec). Resolving either needs a live response, and the run is
   `allowNetwork: false`.

The requirement's own guess was "at least Yellow (envelope schema field)". That is correct
for the *declaration* half of the slice in isolation, but the slice as scoped also contains
the derivation change, and the highest tier wins.

## Route flags

- `needsSecurityReview`: **false** — no auth, config, client, or secret surface touched.
- `requiresFreeloApi`: **true** — contract questions are the blocking issue; would need
  `freelo-api-specialist` to capture a fixture, which `allowNetwork: false` forbids.
- `preApprovedDeps`: `[]` — no new dependencies contemplated.

## Split assessment

The slice decomposes into two parts with different tiers:

| Part | Tier | Why |
|---|---|---|
| Declare `type` on `SubtaskSchema` | Green/Yellow | Field already reaches output via `.passthrough()` (verified). Formalization only. |
| Derive `storage_form` from `type`, retire heuristic | **Red** | Changes shipped envelope + human output; rests on unverified API behavior. |

This split is the substance of the pause question.
