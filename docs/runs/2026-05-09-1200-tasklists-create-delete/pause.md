# Paused at Phase 1 (Spec / API verification)

**Run:** 2026-05-09-1200-tasklists-create-delete
**Reason:** OpenAPI spec has no documented `DELETE /tasklist/{id}` endpoint. Roadmap's R34 entry asserts one exists, but `docs/api/freelo-api.yaml` is the authoritative source per CLAUDE.md and binding rules ("API behavior not in `docs/api/freelo-api.yaml` → Pause; don't guess the API").
**Risk tier:** Red (unexpected — Yellow expected, but spec/roadmap contradiction is a hard pause trigger)

## What happened

The triage agent flagged `requiresFreeloApi: true` and instructed me to verify all three endpoints in `docs/api/freelo-api.yaml` before designing flags. Two of the three endpoints are present and well-documented:

- `POST /project/{project_id}/tasklists` → lines 1140-1178 (`createTasklist`). Body: `{ name (required), budget? }`. Response: `TasklistWithBudget`.
- `POST /tasklist/create-from-template/{template_id}` → lines 1290-1358 (`createTasklistFromTemplate`). Body: `{ tasklist_id (required), target_project_id?, target_tasklist_id?, preset_date_from?, users_ids? }`.

But the third — `DELETE /tasklist/{id}` — is absent. The only operation on `/tasklist/{tasklist_id}` is `GET` (lines 1264-1288). I searched the entire YAML for any tasklist-deletion path including alternates (`POST .../archive`, `POST .../finish`, `delete:` under any tasklist path) and found nothing.

## Evidence

- `docs/api/freelo-api.yaml:1264-1288` — only `get:` defined under `/tasklist/{tasklist_id}`.
- `docs/api/freelo-api.yaml:1235-1572` — full Tasklists section: paths are `POST /project/{id}/tasklists`, `GET /all-tasklists`, `GET /project/{pid}/tasklist/{tid}/assignable-workers`, `GET /tasklist/{id}`, `POST /tasklist/create-from-template/{template_id}`, `GET /project/{pid}/tasklist/{tid}/tasks`, `GET /tasklist/{id}/finished-tasks`. No delete/archive/finish operation on a tasklist.
- `docs/roadmap.md:570-578` — claims `DELETE /tasklist/{id}` exists.

The roadmap also says the dependency is R13 (`src/lib/confirm.ts`) which only matters for the destructive `delete` command. Without a documented delete endpoint, I cannot design the request shape, response handling, idempotency semantics ("delete-of-deleted → 404 vs. soft-delete?"), or error envelope.

## Decision needed

The roadmap and the OpenAPI spec disagree about the existence of `DELETE /tasklist/{id}`. Calibration's binding rule is: when the spec contradicts the roadmap, the spec wins and we pause. Pick a path forward:

Options:
  A. **Drop `tasklists delete` from this slice** — implement the two creates only (`tasklists create` and `tasklists create-from-template`). Rename slice to "Wave 5 final, partial — deletion deferred." Open a new R34.5 once delete is verified. Lowest risk; preserves Wave 5 close-out for the two creates that ARE documented.
  B. **Add the missing endpoint to `docs/api/freelo-api.yaml` first**, with verified evidence (e.g., a captured-against-real-account fixture or an authoritative Freelo doc URL), then run R34 in full. Requires a separate small PR / branch for the spec update before R34 can land.
  C. **Implement all three commands and assume `DELETE /tasklist/{id}` works** like its sibling resources (e.g., `DELETE /task/{id}` — soft delete, 200 on success, 404 on already-deleted). This violates the "don't guess the API" hard rule but would close Wave 5 today. **Not recommended** and against binding rules — listed only for completeness.
  D. Abort the run entirely — re-triage R34 once the API question is resolved.

### Resume with

`/resume 2026-05-09-1200-tasklists-create-delete <A|B|C|D or free-form>`

Note: my recommendation is **A** — partial slice with the two documented creates, defer delete. This keeps the Wave 5 close-out story intact for what we can verify, preserves the Yellow tier, and avoids guessing the API. It also matches the precedent set by R29/R33 (drop a flag whose backing field isn't documented, defer as a follow-up). The slice scope shrinks from three commands to two, which the requirement said was tolerable ("If the architect agent thinks this should split, pause and ask"). I am pausing earlier than the architect agent for a sharper reason: the missing endpoint isn't a scope question — it's a "do not guess the API" rule.
