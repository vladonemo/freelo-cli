## Paused at phase 2 (spec)

**Run:** 2026-05-10-r44-notes-pins
**Reason:** OpenAPI contradicts the R44 roadmap on three independent points; both the `notes list` command and the verb for `notes edit` cannot be implemented as written without picking a behavior the API does not define.
**Risk tier:** Red (escalated from intake-Yellow per pause-rule in the requirement: "OpenAPI disagrees with the roadmap on verb/path/body — especially the 'notes are per-project singular vs many' question. If unclear, pause.")

### What happened

The roadmap (and the requirement brief) ask for eight commands across `notes` and `pins`. Before drafting `docs/specs/0058-r44-notes-pins.md`, the orchestrator cross-checked every endpoint against `docs/api/freelo-api.yaml` (Calibration §1: never guess the API). Three disagreements surfaced:

1. **No `GET /project/{id}/note` listing endpoint exists.** The OpenAPI defines `POST /project/{id}/note` only (lines 4563-4599). There is no listing route on the project, no `/all-notes`, no `/all-documents` — `notes` are stored as `Document` aliases (line 4576) but the document listing API is not exposed either. The roadmap's `freelo notes list --project <id>` is therefore unimplementable against the documented API.
2. **Edit is POST, not PATCH.** The roadmap says `GET/PATCH/DELETE /note/{id}`. OpenAPI defines `GET /note/{id}` (line 4602), `POST /note/{id}` for editing (line 4625), and `DELETE /note/{id}` (line 4661). PATCH does not exist on this resource.
3. **Delete returns the Note, not SuccessResponse.** OpenAPI line 4669: "Response returns the (now-deleted) note's state for confirmation. This is a quirk — most delete endpoints return a SuccessResponse; this one returns the Note." Idempotency design (404 → `already_in_target_state`) needs to decide what `data` looks like when there's no body to echo.

(The pin surface is fine: `POST` body is `{ link, title? }`, `link` is the field name — orchestrator can spec that without help.)

### Evidence

- `docs/api/freelo-api.yaml:4562-4683` — full Notes block; only POST on the project route, POST for edit, DELETE returning Note.
- `docs/api/freelo-api.yaml:1040-1137` — Pinned Items block; `link` (not `url`) is the field, `title` optional, internal-resource POST is idempotent (fetch-or-create), external-URL POST is not.
- Grep across the entire OpenAPI for `/note`, `getNotes`, `listNotes`, `/document`, `/all-document` returns zero listing endpoints.
- Roadmap source: requirement brief quoting `docs/roadmap.md` Wave 7 R44 row.

### Decision needed

How should the CLI surface for **notes list** and **notes edit** be reconciled with the OpenAPI contract?

Options:

  A. **Drop `notes list` from R44; ship 7 commands.**
     - Surface: `notes create / show / edit / delete` (4) + `pins list / add / remove` (3) = 7.
     - `notes edit` uses POST `/note/{id}` (rename the verb internally; keep the CLI flag UX of `--name` / `--content` / `--from-file` / `--editor`).
     - `notes delete` returns the Note's last state in `data` (matches API quirk); 404 → idempotent `{ id, deleted_at: null, already_in_target_state: true }` keeps the standard envelope shape.
     - Tradeoff: surface gap — users must already know a note id (from a `notes create` response, the web UI, or a search result) to use the rest of the surface. Discoverability is poor.
     - This is the safest "ship what the API actually supports" path.

  B. **Add a Freelo-side request and pause R44 entirely.**
     - File a question to the Freelo API team asking whether a project notes/documents listing endpoint exists (perhaps undocumented) or is on their roadmap.
     - Tradeoff: blocks Wave 7 closure for an unknown duration. The wave is otherwise ready to close.

  C. **Implement `notes list` via `GET /project/{id}` and pluck `documents`/`notes` from the project payload, if those embeds exist.**
     - Need to inspect `Project` / `ProjectFull` schema first to confirm the embed.
     - Tradeoff: the listing would only show what the project detail returns, with no pagination/filter parameters. If the embed is missing or partial, the surface lies. Adds a hidden coupling between two endpoints.
     - Likely a fragile workaround; would need its own decision log entry and a test that exercises the embed shape.

  D. **Abort the R44 run; re-scope into R44a (pins, all 3 commands) and R44b (notes, 4 commands minus list) as separate landings.**
     - Tradeoff: two PRs instead of one. Wave 7 closes only after both merge. No new functionality lost vs. option A — just split.

  E. **Abort the R44 run entirely.**

### Resume with

`/resume 2026-05-10-r44-notes-pins <A|B|C|D|E or free-form answer>`

If the answer is A or D, the orchestrator will draft `docs/specs/0058-r44-notes-pins.md` against the seven implementable commands, document the surface gap in the spec's Non-goals section, and continue through implement / test / review / document / PR.

If the answer is B or E, the orchestrator will close the run with a short summary; Wave 7 stays open.

If the answer is C, the orchestrator will first re-read `Project` / `ProjectFull` in the OpenAPI to verify the embed exists; if it does not, the orchestrator will fall back to A and ask for confirmation before proceeding.

### Other autonomous decisions deferred until resume

- Whether `notes edit` and `notes show` accept `--id <int>` (positional) or `--note <int>` (named) — pending resume; will mirror existing single-resource verbs once unblocked.
- Whether `notes create` uses `--name` or `--title` for the note title (OpenAPI calls it `name`; the requirement brief uses "title" prose). Default plan: `--name` to match the API field, with no alias.
- Pin idempotency on `pins remove`: standard 404 → `already_in_target_state: true` exit 0 (no ambiguity; not blocking).

(None of these justify a pause on their own; they are listed so the human reviewer can override on resume if desired.)
