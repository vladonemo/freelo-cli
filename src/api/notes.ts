import { type ApiResponse, type HttpClient } from './client.js';
import { NoteSchema, type Note } from './schemas/note.js';

/**
 * Wire wrappers for the `notes` resource group, R44 (spec 0058).
 *
 * Endpoints (yaml :4562-4683):
 *   - `POST   /project/{project_id}/note`  — create
 *   - `GET    /note/{note_id}`             — show
 *   - `POST   /note/{note_id}`             — edit (verb POST per yaml :4625;
 *                                            roadmap PATCH is incorrect)
 *   - `DELETE /note/{note_id}`             — delete (returns Note, not
 *                                            SuccessResponse — yaml :4669
 *                                            quirk; we surface the body on
 *                                            the envelope for audit use)
 *
 * Every wrapper threads `signal` + `requestId` opt-spreads (calibration §4:
 * branch-coverage in the sibling `test/api/notes.test.ts`).
 */

export type NotesOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  Path helpers — exported so `--dry-run` envelopes can echo the path
 *  without touching the network.
 * ------------------------------------------------------------------------- */

/** Path for `POST /project/{project_id}/note`. */
export function createNotePath(projectId: number): string {
  return `/project/${projectId}/note`;
}

/** Path for `GET /note/{note_id}` and `POST /note/{note_id}` (edit) and `DELETE /note/{note_id}`. */
export function notePath(noteId: number): string {
  return `/note/${noteId}`;
}

/* ---------------------------------------------------------------------------
 *  Wire body shapes
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/project/{project_id}/note`. Per
 * yaml :4584-4592, `name` is required; `content` is optional.
 */
export type CreateNoteBody = {
  name: string;
  content?: string;
};

/**
 * Wire-shape of the POST body for `/note/{note_id}` (edit). Per
 * yaml :4644-4653, `name` is required; `content` is optional.
 *
 * **Note:** the wire requires `name` even on a content-only edit; the
 * leaf command (`src/commands/notes/edit.ts`) issues a `getNote` first to
 * populate `name` when only `--content` is supplied. See spec 0058
 * decision 3.
 */
export type EditNoteBody = {
  name: string;
  content?: string;
};

/* ---------------------------------------------------------------------------
 *  Result envelopes
 * ------------------------------------------------------------------------- */

export type CreateNoteResult = {
  raw: ApiResponse<Note>;
  body: Note;
};

export type GetNoteResult = {
  raw: ApiResponse<Note>;
  body: Note;
};

export type EditNoteResult = {
  raw: ApiResponse<Note>;
  body: Note;
};

export type DeleteNoteResult = {
  raw: ApiResponse<Note>;
  body: Note;
};

/* ---------------------------------------------------------------------------
 *  Wire calls
 * ------------------------------------------------------------------------- */

/**
 * `POST /project/{project_id}/note` — create a project note. Spec 0058 §2.2.
 */
export async function createNote(
  client: HttpClient,
  projectId: number,
  body: CreateNoteBody,
  opts: NotesOpts = {},
): Promise<CreateNoteResult> {
  const raw = await client.request({
    method: 'POST',
    path: createNotePath(projectId),
    body,
    schema: NoteSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `GET /note/{note_id}` — fetch a single note by id. Spec 0058 §2.2.
 */
export async function getNote(
  client: HttpClient,
  noteId: number,
  opts: NotesOpts = {},
): Promise<GetNoteResult> {
  const raw = await client.request({
    method: 'GET',
    path: notePath(noteId),
    schema: NoteSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `POST /note/{note_id}` — overwrite a note's title and/or content. Spec
 * 0058 §2.2; verb is POST per yaml :4625, NOT PATCH (decision 2).
 */
export async function editNote(
  client: HttpClient,
  noteId: number,
  body: EditNoteBody,
  opts: NotesOpts = {},
): Promise<EditNoteResult> {
  const raw = await client.request({
    method: 'POST',
    path: notePath(noteId),
    body,
    schema: NoteSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `DELETE /note/{note_id}` — soft-delete a note. **Quirk** (yaml :4669):
 * the response is the deleted Note's last state, not a SuccessResponse.
 * The leaf command surfaces this on `data.note` for audit-log use cases.
 * Spec 0058 §2.2 / decision 7.
 */
export async function deleteNote(
  client: HttpClient,
  noteId: number,
  opts: NotesOpts = {},
): Promise<DeleteNoteResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: notePath(noteId),
    schema: NoteSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/* ---------------------------------------------------------------------------
 *  Pure body builders — useful for `--dry-run` envelopes (no I/O).
 * ------------------------------------------------------------------------- */

export type CreateNoteInput = {
  name: string;
  content?: string;
};

export function buildCreateNoteBody(input: CreateNoteInput): CreateNoteBody {
  if (input.content !== undefined) {
    return { name: input.name, content: input.content };
  }
  return { name: input.name };
}

export type EditNoteInput = {
  name: string;
  content?: string;
};

export function buildEditNoteBody(input: EditNoteInput): EditNoteBody {
  if (input.content !== undefined) {
    return { name: input.name, content: input.content };
  }
  return { name: input.name };
}
