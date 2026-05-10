# Spec 0058 — `freelo notes` + `freelo pins` (R44, Wave 7)

**Status:** Draft
**Owner:** orchestrator (run `2026-05-10-r44-notes-pins`)
**Roadmap:** R44 (final slice of Wave 7; closes the wave when merged).
**Date:** 2026-05-10
**Depends on:** R04 (`projects show` — established the project-scoped read pattern), R13 (`tasks delete` — established the destructive-flow plumbing for batch + idempotency).

## 1. Problem

Wave 7 is otherwise complete: custom-field catalog, CRUD, value set/clear, and enum
options all shipped. The two remaining per-project knowledge surfaces — **notes**
(rich-text blocks attached to a project) and **pinned items** (links / quick-access
references attached to a project) — are absent from the CLI. Agents using Freelo
for project-management automation cannot:

1. Capture or retrieve project-level meeting minutes / shared reference docs (Notes).
2. List, attach, or detach pinned reference URLs / resources to a project (Pins).

R44 closes those gaps with **two new top-level command parents** and seven
leaves total.

## 2. Proposal

### 2.1 CLI surface (additive — two new parents, seven new leaves)

```
freelo notes create --project <id> --name <str> [--content <str>|--from-file <path>|--editor|-] [--dry-run]
freelo notes show   <id> [--output ...]
freelo notes edit   <id> [--name <str>] [--content <str>|--from-file <path>|--editor|-] [--dry-run]
freelo notes delete <id>... [--ids <list>] [--stdin] [--yes] [--dry-run]

freelo pins  list   --project <id>
freelo pins  add    --project <id> --link <url> [--title <str>] [--dry-run]
freelo pins  remove <id>... [--ids <list>] [--stdin] [--yes] [--dry-run]
```

Standard global flags (`--output`, `--profile`, `--request-id`, `-v`/`-vv`,
`--color`, `-y`/`--yes`) inherit from the root.

Pagination: not applicable. Notes: no listing endpoint exists in OpenAPI (see
§5 Non-goals). Pinned items: yaml :1054 — "The response is a flat array, not
paginated."

### 2.2 Wire mappings

#### `POST /project/{project_id}/note` — `notes create`

OpenAPI yaml :4563-4599.

Request body (yaml :4584-4592):

```jsonc
{
  "name": "<title>",         // required
  "content": "<rich-text body>"  // optional
}
```

Response (yaml :4593-4599): `Note` (yaml :6168-6196 — id, name, date_add,
date_edited_at, state, content, author, project, files[], comments[]).

CLI maps `--name` directly to wire `name` (no rename). `--content` /
`--from-file` / `--editor` / `-` (stdin sentinel) all resolve to the wire
`content` field via the existing `src/lib/input.ts` `readInput` helper —
mirrors `comments add` / `comments edit` / `tasks description set` content
acquisition. Empty content (after trim) is rejected at the command layer
(decision 4).

ACL: project worker+ presumed (yaml does not document explicit roles for
notes — same as documents).

#### `GET /note/{note_id}` — `notes show`

OpenAPI yaml :4602-4624.

Response: `Note` (same shape as create).

Single-resource read. No pagination, no `--with` side-cars in v1 — the
`Note` shape already embeds `files[]` and `comments[]` (yaml :6189-6196), so
the natural read returns everything the API exposes.

#### `POST /note/{note_id}` — `notes edit`

OpenAPI yaml :4625-4660.

**Verb is POST, not PATCH** (roadmap says PATCH; OpenAPI is authoritative —
same precedent as R23 spec 0035 decision 01, R41 spec 0055 decision 01,
R43 spec 0057 decision 01).

Request body (yaml :4644-4653):

```jsonc
{
  "name": "<title>",        // required (yaml :4647-4648)
  "content": "<rich-text>"  // optional
}
```

**Wire requires `name`** even when only `content` is being changed. The CLI
must therefore either (a) require `--name` on edit, or (b) issue a follow-up
GET to fetch the current name when only `--content` is supplied. Decision 5
chooses (b): single GET-then-POST pattern preserves the natural CLI UX of
"change just the body" without forcing the user to re-type the title.

Response: `Note` (yaml :4654-4660).

CLI: at least one of `--name` / `--content` / `--from-file` / `--editor` / `-`
is required (empty edit rejected — decision 6).

#### `DELETE /note/{note_id}` — `notes delete`

OpenAPI yaml :4661-4683.

**Quirk** (yaml :4669): "Response returns the (now-deleted) note's state for
confirmation. This is a quirk — most delete endpoints return a SuccessResponse;
this one returns the Note." We embrace the quirk: live-success envelopes carry
the deleted Note's last state in `data.note` for audit-log use cases. 404
idempotent skips have no body to echo, so `data.note` is **absent** on that
arm (decision 7).

Idempotency (decision 8 — single-arm 404 → `already_in_target_state: true`,
exit 0; matches R23 / R41 / R43).

#### `GET /project/{project_id}/pinned-items` — `pins list`

OpenAPI yaml :1040-1067.

Response: `PinnedItem[]` flat array (yaml :5072-5082 —
`{ id, link, title }`). Empty `[]` is a valid 200 (project has no pins).

ACL-filtered server-side — pinned items the caller cannot see are silently
omitted (yaml :1053). No client-side filter / sort in v1.

#### `POST /project/{project_id}/pinned-items` — `pins add`

OpenAPI yaml :1067-1107.

Request body (yaml :1085-1100):

```jsonc
{
  "link": "<full-url>",   // required (NOT "url" — wire field is "link")
  "title": "<display>"    // optional; server derives a default if omitted
}
```

**Server-side dispatcher** (yaml :1078-1080): if the URL is recognized as an
internal Freelo resource (task, document, file, project-link, project-directory),
the endpoint is **fetch-or-create idempotent** — the same internal-link POST
returns the pre-existing pin row instead of duplicating. For external URLs,
each POST creates a new row even on duplicate.

The CLI does **not** distinguish the two cases on the client side — it's
dispatched server-side by URL pattern, and an over-eager client check would
risk drift with Freelo's recognizer. The server returns the canonical
`PinnedItem` either way; agents can de-duplicate via `pins list` if needed.

Response: `PinnedItem` (yaml :1101-1107).

#### `DELETE /pinned-item/{pinned_item_id}` — `pins remove`

OpenAPI yaml :1109-1137.

Response: `SuccessResponse` (yaml :1131-1137 — `{ result: "success" }`).

Returns 404 if the pinned item does not exist or the caller lacks ACL on the
owning project (yaml :1123). Single-arm 404 idempotency (decision 9).

### 2.3 Output envelopes

Seven new envelope schemas, one per command. All are additive — no existing
schema is changed.

#### `freelo.notes.create/v1`

```jsonc
{
  "schema": "freelo.notes.create/v1",
  "data": {
    "project_id": 100,
    "note": { /* Note shape, present on live success; absent on dry-run */ },
    "byte_length": 1024,           // UTF-8 byte length of content (or 0 if no content)
    "source": "message",            // 'message' | 'file' | 'editor' | 'stdin' | null
                                    //  null = no content was provided (name-only note)
    "would": { "method": "POST", "path": "/project/100/note", "body": {...} }  // dry-run only
  },
  "rate_limit": {...},
  "request_id": "..."
}
```

Notes:
- `note` field is the canonical server-returned `Note` (parsed via
  `NoteSchema`). **Always present** in live envelopes; **absent** in
  `--dry-run`.
- `source` is `null` when neither content flag was passed (note created with
  only `--name`).
- `byte_length` is always present; `0` when no content was supplied.

#### `freelo.notes.show/v1`

```jsonc
{
  "schema": "freelo.notes.show/v1",
  "data": {
    "note": { /* full Note */ }
  },
  "rate_limit": {...},
  "request_id": "..."
}
```

Single-resource read. No `--dry-run` (read-only — same R40 / R43 precedent).

#### `freelo.notes.edit/v1`

```jsonc
{
  "schema": "freelo.notes.edit/v1",
  "data": {
    "note_id": 1234,
    "note": { /* updated Note; live success only */ },
    "applied_changes": { "name": "...", "content": "..." },  // only keys the user set
    "source": "message",            // null when only --name changed
    "byte_length": 1024,            // 0 when only --name changed (no content body sent)
    "would": { "method": "POST", "path": "/note/1234", "body": {...} }  // dry-run only
  }
}
```

Notes:
- `applied_changes` echoes only the keys the user explicitly passed
  (mirrors `labels rename` precedent). The server-side wire body always
  contains both `name` and `content` (because the API requires `name`),
  but `applied_changes` reflects user intent.
- `source` is `null` when no content source was supplied (name-only edit).
- When only `--content` was supplied, the CLI internally fetches the current
  `name` via `GET /note/{id}` first. This GET is a transparent implementation
  detail — not surfaced in `applied_changes`. Both calls share the same
  `requestId`.

#### `freelo.notes.delete/v1`

```jsonc
{
  "schema": "freelo.notes.delete/v1",
  "data": {
    "note_id": 1234,
    "note": { /* deleted Note's last state — only on live 200; absent on 404-idempotent and dry-run */ },
    "previous_state": null,           // reserved for future use; v1 always null
    "current_state": "deleted",
    "already_in_target_state": false, // true iff 404-idempotent skip
    "would": { "method": "DELETE", "path": "/note/1234", "body": {} },  // dry-run only
    "line_index": 0                    // present in --stdin batch mode
  }
}
```

**API quirk** — when the live DELETE returns 200, the body is the deleted
Note (yaml :4669). The CLI surfaces it on `data.note` so audit pipelines
can record the final state. When the live DELETE returns 404, there is no
body — `data.note` is absent and `already_in_target_state: true` is set.

#### `freelo.pins.list/v1`

```jsonc
{
  "schema": "freelo.pins.list/v1",
  "data": {
    "project_id": 100,
    "pins": [
      { "id": 1, "link": "https://...", "title": "..." },
      ...
    ]
  },
  "rate_limit": {...},
  "request_id": "..."
}
```

Empty `pins: []` is valid. No `paging` (flat-array endpoint).

#### `freelo.pins.add/v1`

```jsonc
{
  "schema": "freelo.pins.add/v1",
  "data": {
    "project_id": 100,
    "pin": { "id": 1, "link": "https://...", "title": "..." },  // live only; absent in dry-run
    "applied_link": "https://...",        // echo of --link (the URL as the user passed it)
    "applied_title": "Spec doc",          // echo of --title (omitted when --title not passed)
    "would": { "method": "POST", "path": "/project/100/pinned-items", "body": {...} }
  }
}
```

Notes:
- The server may return a pre-existing pin (fetch-or-create idempotency for
  internal-resource URLs — yaml :1078-1080). The CLI surfaces whatever the
  server returns; it does **not** diff `pin.link` vs `applied_link` or
  emit a `was_existing` flag (would require ad-hoc comparison; not worth
  the surface area in v1 — decision 10).

#### `freelo.pins.remove/v1`

```jsonc
{
  "schema": "freelo.pins.remove/v1",
  "data": {
    "pin_id": 1,
    "previous_state": null,            // reserved; v1 always null
    "current_state": "removed",
    "already_in_target_state": false,
    "would": { "method": "DELETE", "path": "/pinned-item/1", "body": {} },
    "line_index": 0
  }
}
```

Mirrors `labels delete` envelope (no body to echo on success — server returns
`SuccessResponse`).

### 2.4 Error mapping

Inherits from `FreeloApiError` and the global error handler (typed exit codes
via `BaseError.exitCode`). Per-leaf hint rewrites:

- `notes create`:
  - 400  → "Server-side validation rejected the request; verify --name is non-empty and --project is a project you can write to."
  - 403  → "Account does not have permission to create notes in this project."
  - 404  → "Project not found. Run `freelo projects list` for ids."

- `notes show`:
  - 403  → "Account does not have permission to read this note."
  - 404  → "Note not found, or your account does not have permission to read it (Freelo collapses the two cases to avoid leaking note existence)."

- `notes edit`:
  - 400  → "Server-side validation rejected the request; verify --name is non-empty if supplied."
  - 403  → permission hint.
  - 404  → "Note not found, or your account does not have permission to edit it." **NOT idempotent** — edit-of-deleted is a real failure.

- `notes delete`:
  - 403  → "Account does not have permission to delete this note."
  - 404  → idempotent skip (single-arm).

- `pins list`:
  - 403  → "Account does not have permission to read pinned items on this project."
  - 404  → "Project not found. Run `freelo projects list` for ids."

- `pins add`:
  - 400  → "Server-side validation rejected the request; verify --link is a well-formed URL and the project is one you can write to."
  - 403  → "Account does not have permission to pin items in this project."
  - 404  → "Project not found."

- `pins remove`:
  - 403  → "Account does not have permission to remove this pinned item."
  - 404  → idempotent skip (single-arm).

### 2.5 Confirmation copy

- `notes delete` (single):  `"Delete 1 note?"`
- `notes delete` (N):       `"Delete N notes?"`
- `pins remove` (single):   `"Remove 1 pinned item?"`
- `pins remove` (N):        `"Remove N pinned items?"`

The "GLOBALLY" pattern from `labels delete` does not apply (notes and pins
are project-scoped, not workspace-global).

### 2.6 Batch input

`notes delete` and `pins remove` support the standard three-source batch
input (positional `<id>...` / `--ids` / `--stdin` NDJSON). The other five
leaves are single-shot:

- `notes create` — single project + single note per call. Bulk-add via
  shell loop.
- `notes show` — single id per call (read).
- `notes edit` — single id per call. Mixed-content batch via NDJSON would
  require per-row content sources, but the comments-edit precedent already
  shows that this complicates the surface beyond its value here. v1 is
  single-shot; if a use case emerges we can extend in a future minor.
- `pins list` — single project per call (read).
- `pins add` — single link per call (mirrors `labels rename`-style single-shot;
  bulk-pin via shell loop).

NDJSON line schemas:

```jsonc
// notes delete --stdin
{ "id": <positive int> }

// pins remove --stdin
{ "id": <positive int> }
```

## 3. Data model

### 3.1 Zod schemas (new in `src/api/schemas/note.ts` and `src/api/schemas/pin.ts`)

```ts
// src/api/schemas/note.ts
import { z } from 'zod';
import { UserBasicSchema, ProjectBasicSchema } from './project.js';
import { StateSchema } from './...'; // existing State schema location

/**
 * `Note` — yaml :6168-6196. The wire shape is loose: `id`/`state`/`author`/
 * `project` may be absent in some response variants (the OpenAPI does not
 * mark fields required), and `files[]`/`comments[]` are present in the
 * detail/show response but not always in the create response (depending
 * on server behavior at insert time).
 *
 * `.passthrough()` so future API additions (e.g. attachments metadata)
 * don't break validation.
 */
export const NoteSchema = z
  .object({
    id: z.number().int(),
    name: z.string(),
    content: z.string().optional(),
    date_add: z.string().optional(),
    date_edited_at: z.string().optional(),
    state: StateSchema.optional(),
    author: UserBasicSchema.optional(),
    project: ProjectBasicSchema.optional(),
    files: z.array(z.unknown()).optional(),     // structured FileFull elsewhere
    comments: z.array(z.unknown()).optional(),  // structured CommentWithFiles elsewhere
  })
  .passthrough();
export type Note = z.infer<typeof NoteSchema>;

// Envelope-data types
export type NotesCreateData = {
  project_id: number;
  note?: Note;                                   // absent on dry-run
  byte_length: number;                           // 0 when no content
  source: 'message' | 'file' | 'editor' | 'stdin' | null;
  would?: Would;
};

export type NotesShowData = { note: Note };

export type NotesEditData = {
  note_id: number;
  note?: Note;
  applied_changes: { name?: string; content?: string };
  source: 'message' | 'file' | 'editor' | 'stdin' | null;
  byte_length: number;
  would?: Would;
};

export type NotesDeleteData = {
  note_id: number;
  note?: Note;                                   // present iff live 200
  previous_state: null;
  current_state: 'deleted';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};
```

```ts
// src/api/schemas/pin.ts
import { z } from 'zod';

/** `PinnedItem` — yaml :5072-5082. Loose; passthrough. */
export const PinnedItemSchema = z
  .object({
    id: z.number().int(),
    link: z.string().optional(),
    title: z.string().optional(),
  })
  .passthrough();
export type PinnedItem = z.infer<typeof PinnedItemSchema>;

/** `GET /project/{id}/pinned-items` — flat array. */
export const PinnedItemsListResponseSchema = z.array(PinnedItemSchema);
export type PinnedItemsListResponse = z.infer<typeof PinnedItemsListResponseSchema>;

// Envelope-data types
export type PinsListData = {
  project_id: number;
  pins: PinnedItem[];
};

export type PinsAddData = {
  project_id: number;
  pin?: PinnedItem;
  applied_link: string;
  applied_title?: string;
  would?: Would;
};

export type PinsRemoveData = {
  pin_id: number;
  previous_state: null;
  current_state: 'removed';
  already_in_target_state: boolean;
  would?: Would;
  line_index?: number;
};
```

## 4. Edge cases

1. **`notes create` with no content flags** → name-only note, `byte_length: 0`,
   `source: null`. Wire body omits `content` field (POST `{ "name": "..." }`).
2. **`notes create --name "" `** (empty after trim) → `ValidationError` exit 2.
3. **`notes edit` with no change flags** → `ValidationError` exit 2 ("at least
   one of --name / --content / --from-file / --editor / - is required").
4. **`notes edit --content "..."` (no `--name`)** → CLI issues GET `/note/{id}`
   to fetch the current name, then POSTs with `{ name: <fetched>, content: <new> }`.
   GET-step error (404) bubbles before any POST; same hint as direct `notes show`.
5. **`notes edit --name "" `** (empty after trim) → `ValidationError` exit 2.
6. **`notes edit --content ""`** (empty after trim) → `ValidationError` exit 2
   (consistent with comments-edit precedent — empty content on a non-empty edit
   intent is rejected to avoid silent body-clobbering).
7. **`notes delete` of a note that was already deleted** → 404 → idempotent
   skip; envelope `already_in_target_state: true`, `data.note` absent, exit 0.
8. **`notes delete` 200** → envelope `data.note` carries the deleted Note's
   last state.
9. **`pins add --link "not-a-url"`** → server validates; we don't pre-validate
   on the client (no URL parsing on the CLI). 400 → friendly hint.
10. **`pins add` for an internal-resource URL with an existing pin** → server
    returns the pre-existing pin (yaml :1078). Envelope carries the returned
    `PinnedItem`; no separate signal that this was a fetch-or-create case.
11. **`pins remove` 404** → idempotent skip; exit 0; no body to echo.
12. **Empty `--stdin`** for `notes delete` / `pins remove` → silent success,
    exit 0 (mirrors R23 / R41 / R43 conventions).
13. **NDJSON line with malformed `id`** → per-line `freelo.error/v1` envelope
    with `line_index`; exit code aggregated.
14. **Bad id in positional / --ids** → exit 2 `VALIDATION_ERROR` before any
    wire call.
15. **Auth (401) / forbidden (403) / rate limit (429) / 5xx / network** →
    standard typed exit codes (3, 4, 6, 4, 4).
16. **Non-TTY without `--yes`** on `notes delete` / `pins remove` →
    `ConfirmationError` exit 2 BEFORE any wire call.
17. **`notes delete --dry-run`** / **`pins remove --dry-run`** → no wire call,
    no confirmation prompt; envelope carries `would.method = "DELETE"`.
18. **Mid-stream batch failure** (one of N ids 404s after another succeeded) →
    per-id envelopes go to stdout, highest-of exit code wins (uniform with R13 /
    R23 / R41 batch).
19. **`notes edit` with both `--name` AND content flags** → both fields included
    in the POST body. `applied_changes` echoes both. Single POST (no GET step).
20. **`notes edit --editor`** in a non-TTY environment → `ValidationError`
    (handled by `readInput` helper — same as `comments edit --editor`).
21. **`pins list` empty** → envelope `data.pins: []`, exit 0. Human-mode renders
    "No pinned items."

## 5. Non-goals

- **`notes list`** — **not implementable in v1.** OpenAPI defines no project-
  scoped notes/documents listing endpoint. The web UI presumably backs into a
  Project endpoint that embeds documents, but that embed is not exposed in the
  documented API. Adding `notes list` requires a Freelo-side API change. Reserved
  for **R45+** when an endpoint becomes available; the spec note here makes the
  gap visible to future planners.
- **`notes restore`** — there is no restore endpoint for notes (yaml documents
  delete as soft-delete-with-audit-retention but no `/restore` route).
- **`pins reorder` / `pins move`** — no documented endpoint.
- **Bulk note creation** (multiple notes from one CLI call) — single-shot only
  in v1; compose via shell loop or NDJSON-driven script.
- **Bulk pin add** — same.
- **`pins add` for internal Freelo resources via id rather than URL** — the
  documented endpoint accepts only a URL; the server does the URL→resource
  recognition. Adding an `--id <int> --kind <task|file|...>` surface would
  require a parallel client-side URL builder that drifts from Freelo's
  recognizer.
- **Filtering / sorting `pins list`** — flat-array endpoint with no query
  parameters; client-side filtering would be feature creep.
- **`--with files` / `--with comments` side-cars on `notes show`** — the
  `Note` shape already embeds these (yaml :6189-6196). Conditional projection
  would add surface without saving an HTTP call.
- **Validating `--link` URL syntactically client-side** — the server's URL
  recognizer is the canonical validator (per yaml :1078-1080); pre-validating
  risks rejecting URLs the server would accept.
- **Surfacing `pins add` "this was a fetch-or-create idempotent return"** as
  a discrete envelope flag — would require ad-hoc URL inspection client-side
  (see decision 10). Out of scope.

## 6. Open questions

None. The OpenAPI is now unambiguous on every contract this slice touches
(after the resume that resolved the listing-endpoint question with Option A).

## 7. Decisions made autonomously

1. **`notes list` is dropped from R44.** Resume answer (Option A) — the
   listing endpoint does not exist in OpenAPI; surface gap is documented in §5.
2. **Verb for `notes edit` is POST.** OpenAPI yaml :4625 is canonical;
   roadmap entry's PATCH is incorrect. Same precedent as R23 / R41 / R43.
3. **`notes edit --content "..."` (no `--name`) issues a transparent GET
   first.** Wire requires `name` (yaml :4647-4648), so we cannot send
   content-only. Auto-fetching preserves the natural CLI UX. The GET error
   bubbles before any POST.
4. **Empty `--name` / `--content` (after trim) on create / edit are
   rejected** at the CLI layer with `ValidationError` exit 2. Mirrors
   `comments add` / `comments edit` decision 3 — silent body-clobbering is
   a footgun.
5. **`notes edit` requires at least one change flag.** `--name` /
   `--content` / `--from-file` / `--editor` / `-`. Empty edit is rejected
   (mirrors R23 `labels rename` decision 04, R41 `custom-fields rename`).
6. **`notes show` / `notes edit` / `notes delete` use `<id>` positional.**
   Mirrors `tasks show`, `comments edit`, `custom-fields rename`. No `--note`
   alias (per resume — pause-rule confirmed).
7. **`notes delete` 200 envelope includes `data.note`** — the API quirk
   (yaml :4669) gives us the deleted Note's last state for free; surfacing it
   on the envelope helps audit pipelines without a follow-up GET. **404 idempotent**
   envelope omits `data.note` (no body to echo).
8. **`notes delete` single-arm 404 idempotency.** Matches R23 / R41 / R43
   convention.
9. **`pins remove` single-arm 404 idempotency.** Same as above. yaml :1123
   conflates "doesn't exist" with "no ACL on project"; both map to "user got
   the absent end-state they asked for".
10. **`pins add` does not surface a `was_existing` flag.** The fetch-or-create
    behavior (yaml :1078-1080) is server-side; surfacing it would require
    ad-hoc client-side URL inspection. Agents that care can `pins list` first.
11. **`--name` is the create-flag (matches API field exactly; no `--title`
    alias).** Per pause-decision retention. The OpenAPI calls the title
    `name`; the brief used "title" in prose only.
12. **`pins add --link <url>` (NOT `--url`).** Wire field is `link`
    (yaml :1094). Same naming-mirror precedent as `--name`.
13. **No client-side URL syntactic validation on `--link`.** The server's
    URL recognizer is canonical (yaml :1078-1080); pre-validating risks
    drift.
14. **Notes / Pins are top-level command parents, not nested under
    `projects`.** The wire endpoints split between project-scoped (create /
    list / add) and resource-scoped (show / edit / delete / remove). A
    `freelo projects notes …` parent would not match the resource-scoped
    leaves. Two flat parents are clearer; mirrors the existing `tasks` /
    `tasklists` / `comments` precedent.
15. **Both `Note` and `PinnedItem` schemas are loose / passthrough.** Same
    convention as `CommentFull`, `PinnedItem` shape may grow, and the wire
    shape is incompletely documented in OpenAPI (most fields not marked
    required). Strict shapes risk breaking on a server-side addition.
16. **Note schema fields (other than `id`/`name`) are `.optional()`.** The
    OpenAPI does not declare any field `required` (yaml :6168-6196), and
    create vs show vs delete responses differ subtly. Strict required fields
    would risk `ZodError` on a valid response.
17. **Nothing depends on Wave 8 (R45+).** R44 closes Wave 7 cleanly.

## Plan

### Files to create

- `src/commands/notes.ts` — registers the `notes` parent (mirrors
  `comments.ts`).
- `src/commands/notes/create.ts` — `notes create --project <id> --name <str>`.
- `src/commands/notes/show.ts` — `notes show <id>`.
- `src/commands/notes/edit.ts` — `notes edit <id> [--name | --content ...]`.
- `src/commands/notes/delete.ts` — `notes delete <id>...` batch destructive.
- `src/commands/pins.ts` — registers the `pins` parent.
- `src/commands/pins/list.ts` — `pins list --project <id>`.
- `src/commands/pins/add.ts` — `pins add --project <id> --link <url>`.
- `src/commands/pins/remove.ts` — `pins remove <id>...` batch destructive.
- `src/api/notes.ts` — wire wrappers (`createNote`, `getNote`, `editNote`,
  `deleteNote`) + path helpers.
- `src/api/pins.ts` — wire wrappers (`getPinnedItems`, `pinItem`,
  `deletePinnedItem`) + path helpers.
- `src/api/schemas/note.ts` — `NoteSchema` + envelope-data types.
- `src/api/schemas/pin.ts` — `PinnedItemSchema` + envelope-data types.
- `src/ui/human/notes-create.ts` — live + dry-run.
- `src/ui/human/notes-show.ts` — single-note renderer.
- `src/ui/human/notes-edit.ts` — live + dry-run.
- `src/ui/human/notes-delete.ts` — live / 404-idempotent / dry-run.
- `src/ui/human/pins-list.ts` — empty / non-empty.
- `src/ui/human/pins-add.ts` — live + dry-run.
- `src/ui/human/pins-remove.ts` — live / 404-idempotent / dry-run.
- `test/api/notes.test.ts` — sibling api tests for wrappers + opt-spread
  branches (Calibration §4).
- `test/api/pins.test.ts` — same.
- `test/commands/notes/create.test.ts` — happy + dry-run + 400/403/404/429/5xx/net
  + `--output human` happy + content-source variants.
- `test/commands/notes/show.test.ts` — happy + 403/404 + human happy + human
  not-found.
- `test/commands/notes/edit.test.ts` — happy + dry-run + content-only-with-GET-step
  + 400/403/404/429/5xx/net + human happy + human error.
- `test/commands/notes/delete.test.ts` — full pattern from `labels/delete.test.ts`,
  including multi-id mid-stream-failure in BOTH json and human modes (Calibration
  §4 / R42 lessons).
- `test/commands/pins/list.test.ts` — happy + empty + 403/404 + human happy +
  human empty.
- `test/commands/pins/add.test.ts` — happy + dry-run + 400/403/404/429/5xx/net
  + human happy + human error.
- `test/commands/pins/remove.test.ts` — full pattern from `labels/delete.test.ts`,
  including multi-id mid-stream-failure in BOTH json and human modes.
- `docs/commands/notes-create.md`
- `docs/commands/notes-show.md`
- `docs/commands/notes-edit.md`
- `docs/commands/notes-delete.md`
- `docs/commands/pins-list.md`
- `docs/commands/pins-add.md`
- `docs/commands/pins-remove.md`
- `.changeset/r44-notes-pins.md` — minor bump.

### Files to modify

- `src/bin/freelo.ts` — add two `register(...)` calls in the existing block
  (one for `notes`, one for `pins`).
- `test/msw/handlers.ts` — add `notesHandlers` block (one factory per
  endpoint × status pair) and `pinsHandlers` block.
- `README.md` — autogen Commands block (regenerated via `pnpm fix:readme`).
- `docs/roadmap.md` — mark R44 as ✅ shipped (referencing this PR), add a
  "Wave 7 status" note that the wave is fully shipped after this PR merges.

### Test strategy

Per Calibration §1, §2, §4, §7:

- Every error path with a typed exit code has an exit-code assertion.
- Every command has both `--output json` and `--output human` paths covered.
- `notes delete` and `pins remove` cover the multi-id mid-stream-failure case
  in BOTH json and human output modes (R42 lessons).
- `notes edit` covers the GET-then-POST path (content-only without `--name`)
  with one MSW handler responding to both `GET /note/{id}` and
  `POST /note/{id}` in sequence.
- Sibling api wrapper tests cover both the absent-opts and present-opts
  spread branches.
- Whitespace / empty-after-trim tests for `--name`, `--content`, `--link`
  validators.
- For destructive ops with idempotency: 404-idempotent `--output human` test.
- No TTY-prompt tests in this slice (non-TTY paths with `--yes` are
  sufficient for confirmation policy coverage); any tests that DO assert
  TTY-prompt copy must clear `process.env.CI` per Calibration §7.

### Rollout order

One slice — landing the seven commands together keeps the surface coherent.
The `notes` and `pins` parents are independent (no shared API or schema), so
order within the slice is implementation-detail; tests are independent per
leaf.

### No new deps

All imports come from existing modules:
- `commander` (existing)
- `zod` (existing)
- `src/api/client.ts` (existing)
- `src/lib/input.ts`, `src/lib/dry-run.ts`, `src/lib/confirm.ts`,
  `src/lib/batch.ts`, `src/lib/introspect.ts` (existing)
- `src/ui/envelope.ts`, `src/ui/render.ts` (existing)
- `src/errors/*` (existing)
