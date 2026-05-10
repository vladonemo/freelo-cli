import { z } from 'zod';
import { type Would } from '../../lib/dry-run.js';
import { UserBasicSchema } from './project.js';

/**
 * Zod schemas for the `notes` resource group, R44 (spec 0058).
 *
 * Wire shape: `Note` from OpenAPI :6168-6196. Loose by design — the
 * OpenAPI does not declare any field `required`, and the create / show /
 * delete responses differ subtly:
 *
 *   - `id` and `name` are universally present in practice.
 *   - `content` is optional (notes can be name-only — wire-body POST omits
 *     it when the user passes `--name` only).
 *   - `state`, `author`, `project`, `files[]`, `comments[]` are present on
 *     the show / detail response but not always on create.
 *   - `date_add` / `date_edited_at` are returned on every variant we've
 *     seen, but documented loosely.
 *
 * `.passthrough()` so future API additions (e.g. attachments metadata,
 * version history) don't break validation. Per spec 0058 decision 15.
 */

const NoteStateSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    state: z.string().nullable().optional(),
  })
  .passthrough();

const NoteProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

const NoteFileRefSchema = z
  .object({
    uuid: z.string().nullable().optional(),
  })
  .passthrough();

const NoteCommentRefSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    uuid: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `Note` — yaml :6168-6196. Strict requirements limited to `id` (universally
 * present); every other field is `.nullable().optional()` to match the
 * loose API contract. Spec 0058 decision 16.
 */
export const NoteSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
    content: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    date_edited_at: z.string().nullable().optional(),
    state: NoteStateSchema.nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    project: NoteProjectRefSchema.nullable().optional(),
    files: z.array(NoteFileRefSchema).nullable().optional(),
    comments: z.array(NoteCommentRefSchema).nullable().optional(),
  })
  .passthrough();

export type Note = z.infer<typeof NoteSchema>;

/* ---------------------------------------------------------------------------
 *  Source enum — mirrors `comments add`/`edit`. `null` = no content was
 *  supplied (name-only create, or name-only edit).
 * ------------------------------------------------------------------------- */

export const NoteContentSourceSchema = z.enum(['message', 'file', 'editor', 'stdin']);
export type NoteContentSource = z.infer<typeof NoteContentSourceSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope-data types
 *
 *  Per spec 0058 §2.3. All envelopes are additive; no existing schema is
 *  changed.
 * ------------------------------------------------------------------------- */

export type NotesCreateData = {
  project_id: number;
  /** Server-returned Note. Present on live success; absent in --dry-run. */
  note?: Note;
  /** UTF-8 byte length of the content sent. Always present; 0 when no content. */
  byte_length: number;
  /**
   * Source of the content. `null` when no content flag was passed (name-only
   * note). Otherwise `'message' | 'file' | 'editor' | 'stdin'`.
   */
  source: NoteContentSource | null;
  /** Only in --dry-run envelopes. */
  would?: Would;
};

export type NotesShowData = {
  note: Note;
};

export type NotesEditData = {
  note_id: number;
  /** Server-returned Note (post-edit). Present on live success; absent in --dry-run. */
  note?: Note;
  /**
   * Echo of only the keys the user explicitly set on the CLI. The wire
   * body always carries both `name` and `content` (because the API
   * requires `name`); `applied_changes` reflects user intent.
   */
  applied_changes: { name?: string; content?: string };
  /** `null` when only --name was changed (no content body sent). */
  source: NoteContentSource | null;
  /** UTF-8 byte length of content. 0 when only --name changed. */
  byte_length: number;
  would?: Would;
};

export type NotesDeleteData = {
  note_id: number;
  /**
   * The deleted Note's last state. **Present only on live 200** (Freelo
   * quirk per yaml :4669: this DELETE returns the Note rather than a
   * SuccessResponse). **Absent on 404-idempotent and --dry-run** —
   * there's no body to echo.
   */
  note?: Note;
  previous_state: null;
  current_state: 'deleted';
  already_in_target_state: boolean;
  would?: Would;
  /** Present only in --stdin batch mode. */
  line_index?: number;
};
