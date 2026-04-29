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
