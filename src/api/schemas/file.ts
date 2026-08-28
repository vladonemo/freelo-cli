/**
 * Zod schemas for the `files` resource group, R25 (spec 0037).
 *
 * Wire endpoint (yaml :3867-3907):
 *   - `POST /file/upload` (multipart/form-data) — upload a single file (max
 *     100 MB) and receive a UUID that other endpoints can reference.
 *
 * Note: the OpenAPI spec is internally inconsistent. The `/file/upload`
 * response inline schema returns `{ uuid: format: uuid }` (yaml :3905) but
 * the global `FileUpload` schema (used by comment/description endpoints,
 * yaml :5563) requires `download_url` and `filename`. The upload endpoint
 * returns the inline `{uuid}` shape — see spec 0037 decision 02 for how
 * `--attach-to-task` reconciles this.
 *
 * Loose by design: `passthrough()` so unknown server fields don't break us.
 */

import { z } from 'zod';

/* ---------------------------------------------------------------------------
 *  POST /file/upload — response envelope
 *
 *  Just `{ uuid: <uuid-string> }`. The schema accepts any non-empty string
 *  for `uuid` (the server's UUID format may evolve; we don't care as long
 *  as we can echo it back). `passthrough()` tolerates additional fields
 *  the server might add (e.g. download_url) without forcing a schema bump.
 * ------------------------------------------------------------------------- */

export const FileUploadResponseSchema = z
  .object({
    uuid: z.string().min(1),
  })
  .passthrough();
export type FileUploadResponse = z.infer<typeof FileUploadResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Shared `would` shape for dry-run envelopes
 *
 *  R25 makes 1..N+1 POSTs per invocation (N uploads + maybe 1 comment), so
 *  envelope `data.would` is an **array** rather than a single object —
 *  spec 0037 decision 10.
 * ------------------------------------------------------------------------- */

const WouldEntrySchema = z.object({
  method: z.literal('POST'),
  path: z.string(),
  body: z.unknown(),
});

/* ---------------------------------------------------------------------------
 *  freelo.files.upload/v1
 *
 *  Envelope `data` for `freelo files upload`. Reports per-path success/fail
 *  rather than aborting on the first error — the multi-path partial-failure
 *  semantics live in the command layer (§5.5 of spec 0037).
 *
 *  - `uploaded[]`: one entry per successful upload, with the server-assigned
 *    UUID and the byte count we shipped (audit trail).
 *  - `failed[]`: one entry per failed upload, with a typed error code so
 *    agents can branch (`AUTH_EXPIRED` vs `RATE_LIMITED` vs `VALIDATION`).
 *  - `count`: triple of (requested, uploaded, failed) — convenience for
 *    renderers and assertions.
 *  - `attached?`: present only when `--attach-to-task` produced a comment.
 *  - `would?`: present only on `--dry-run`.
 * ------------------------------------------------------------------------- */

export const FilesUploadedEntrySchema = z.object({
  path: z.string(),
  filename: z.string(),
  bytes: z.number().int().min(0),
  uuid: z.string().min(1),
});
export type FilesUploadedEntry = z.infer<typeof FilesUploadedEntrySchema>;

export const FilesFailedEntrySchema = z.object({
  path: z.string(),
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});
export type FilesFailedEntry = z.infer<typeof FilesFailedEntrySchema>;

export const FilesUploadAttachedSchema = z.object({
  task_id: z.number().int().positive(),
  comment_id: z.number().int().positive(),
  file_uuids: z.array(z.string().min(1)),
});
export type FilesUploadAttached = z.infer<typeof FilesUploadAttachedSchema>;

export const FilesUploadDataSchema = z.object({
  uploaded: z.array(FilesUploadedEntrySchema),
  failed: z.array(FilesFailedEntrySchema),
  count: z.object({
    requested: z.number().int().min(0),
    uploaded: z.number().int().min(0),
    failed: z.number().int().min(0),
  }),
  attached: FilesUploadAttachedSchema.optional(),
  would: z.array(WouldEntrySchema).optional(),
});
export type FilesUploadData = z.infer<typeof FilesUploadDataSchema>;

/* ---------------------------------------------------------------------------
 *  R26 — `freelo files list`  (spec 0038)
 *
 *  Wire endpoint: `GET /all-docs-and-files` (yaml :3909-3954).
 *  Inner key: `items` (NOT `reports`/`comments`/`tasks`).
 *
 *  `FileItem` (yaml :5973-6026) is union-ish — fields like `filename`,
 *  `mime_type`, `size`, `link`, `link_type`, `items_count` apply to a subset
 *  of the four type values. Loose-by-design: all of them are
 *  `.nullable().optional()` so a `directory` row missing `mime_type` doesn't
 *  trip the schema. `type` itself is the only required-non-null field beyond
 *  `uuid` — required because the renderer's size column branches on it.
 *
 *  `UserBasicSchema` is local rather than imported from `schemas/project.ts`:
 *  the project copy is NOT passthrough, and `FileItem.author` may carry
 *  avatar/email/role on some endpoints. Same divergence rationale as
 *  `report.ts` (spec 0033 §10).
 * ------------------------------------------------------------------------- */

const UserBasicSchema = z
  .object({
    id: z.number().int(),
    fullname: z.string().nullable().optional(),
  })
  .passthrough();

const ProjectRefSchema = z
  .object({
    id: z.number().int(),
    name: z.string().nullable().optional(),
  })
  .passthrough();

export const FileItemTypeSchema = z.enum(['directory', 'link', 'file', 'document']);
export type FileItemType = z.infer<typeof FileItemTypeSchema>;

export const FileItemSchema = z
  .object({
    uuid: z.string().min(1),
    name: z.string().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    project: ProjectRefSchema.nullable().optional(),
    directory_uuid: z.string().nullable().optional(),
    date_add: z.string().nullable().optional(),
    order: z.number().int().nullable().optional(),
    type: FileItemTypeSchema,
    filename: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
    mime_type: z.string().nullable().optional(),
    extension: z.string().nullable().optional(),
    size: z.number().int().nullable().optional(),
    color: z.string().nullable().optional(),
    items_count: z.number().int().nullable().optional(),
    link: z.string().nullable().optional(),
    link_type: z.string().nullable().optional(),
    note: z.string().nullable().optional(),
  })
  .passthrough();
export type FileItem = z.infer<typeof FileItemSchema>;

/**
 * Echo of the user's filter set in the `freelo.files.list/v1` envelope.
 * `type` carries the **wire form** (`document` / `directory` / `file` /
 * `link`) — see decision 03 in the spec-0038 run docs. Agents round-tripping
 * to Freelo's REST get a string they can pass straight through.
 */
export const FilesListAppliedFiltersSchema = z.object({
  projects: z.array(z.number().int()).optional(),
  type: FileItemTypeSchema.optional(),
});
export type FilesListAppliedFilters = z.infer<typeof FilesListAppliedFiltersSchema>;

export const FilesListDataSchema = z.object({
  applied_filters: FilesListAppliedFiltersSchema,
  items: z.array(FileItemSchema),
});
export type FilesListData = z.infer<typeof FilesListDataSchema>;

/* ---------------------------------------------------------------------------
 *  R27 — `freelo files download`  (spec 0039)
 *
 *  Wire endpoint: `GET /file/{file_uuid}` (yaml :3835-3865) — returns
 *  `application/octet-stream` (binary). NO Zod schema for the response body
 *  itself; the schema below is for the success **envelope** only.
 *
 *  Spec 0039 §4.1.
 * ------------------------------------------------------------------------- */

export const FilesDownloadDataSchema = z.object({
  /** The UUID we asked for (echoed for trace correlation). */
  uuid: z.string().min(1),
  /**
   * Where the bytes ended up. Either the literal string `'stdout'` (when
   * `--stdout` was set) or an absolute filesystem path. Spec 0039 §3.4.
   */
  destination: z.union([z.literal('stdout'), z.string().min(1)]),
  /** Bytes actually written. May differ from `Content-Length` if the server lied. */
  bytes: z.number().int().min(0),
  /** Server-provided filename (from `Content-Disposition`). `null` if absent. */
  filename: z.string().min(1).nullable(),
  /** Server-provided MIME (from `Content-Type`). `null` if absent. */
  content_type: z.string().min(1).nullable(),
  /** True iff `--force` was used and a pre-existing destination was overwritten. */
  overwrote: z.boolean(),
});
export type FilesDownloadData = z.infer<typeof FilesDownloadDataSchema>;

/* ---------------------------------------------------------------------------
 *  M07 — `freelo files delete`  (spec 0064)
 *
 *  Wire endpoint: `DELETE /file/{file_uuid}` (yaml :4492-4521,
 *  `deleteDocOrFileByUuid`) — soft-deletes a file **or** a document/note,
 *  resolving which from the UUID server-side.
 *
 *  The 200 body is a bare `SuccessResponse` with no per-resource detail, so
 *  `data` can only echo the input and the verb's implied outcome. In
 *  particular there is deliberately **no** `type` / `kind` field: the endpoint
 *  never reports whether it removed a file or a document, and inventing one
 *  would be a guess (spec 0064 §4.2).
 *
 *  Spec 0064 §4.1.
 * ------------------------------------------------------------------------- */

export const FilesDeleteDataSchema = z.object({
  /** The UUID we asked to delete (echoed for trace correlation). */
  uuid: z.string().min(1),
  current_state: z.literal('deleted'),
  /**
   * Always `false` in v1 — this command never absorbs a 404 into an idempotent
   * success, because a 404 here means "missing **or** not visible to you"
   * (yaml :4504), so absorbing it could report success for a document that is
   * still there (spec 0064 §5.1).
   *
   * Kept in the envelope for cross-command consistency with
   * `freelo.tasks.delete/v1` and `freelo.comments.delete/v1`: an agent
   * scripting deletes across resources reads one uniform field rather than a
   * per-resource special case.
   */
  already_in_target_state: z.boolean(),
  /** Present only on `--dry-run` — echoes the call that would have been made. */
  would: z
    .object({
      method: z.literal('DELETE'),
      path: z.string(),
      body: z.unknown(),
    })
    .optional(),
  /** Present only in `--stdin` batch mode: the 0-based input line index. */
  line_index: z.number().int().min(0).optional(),
});
export type FilesDeleteData = z.infer<typeof FilesDeleteDataSchema>;
