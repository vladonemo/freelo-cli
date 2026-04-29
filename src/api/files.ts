/**
 * Wire wrappers for the `files` resource group, R25 (spec 0037).
 *
 * v1 endpoint:
 *   - `POST /file/upload` (multipart/form-data) — single-file upload.
 *
 * The upload returns just `{ uuid }`. To "attach" a file to a task, the
 * documented mechanism is a separate `POST /task/{id}/comments` call whose
 * `content` embeds `<a data-freelo-uuid="{uuid}">name</a>` anchors
 * (yaml :3876). That second hop is wired by the leaf command — this module
 * only handles the upload step.
 */

import { type ApiResponse, type HttpClient } from './client.js';
import { FileUploadResponseSchema, type FileUploadResponse } from './schemas/file.js';
import { type MultipartFile } from '../lib/multipart.js';

/** Path constant — exposed so dry-run envelopes can echo it without a wire call. */
export const FILE_UPLOAD_PATH = '/file/upload';

/** Two-field opts shape mirroring the existing `FetchOpts` convention. */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type UploadFileOpts = FetchOpts & {
  /** Pre-built multipart body from `buildFileMultipart`. */
  multipart: MultipartFile;
};

export type UploadFileResult = {
  /** The server-assigned UUID extracted from the response. */
  uuid: string;
  /** The basename we sent (echoed for the envelope). */
  filename: string;
  /** The byte count we sent (audit). */
  bytes: number;
  /** Full ApiResponse for rate-limit + request-id propagation. */
  raw: ApiResponse<FileUploadResponse>;
};

/**
 * `POST /file/upload` — single-file multipart upload. The OpenAPI spec
 * (yaml :3867-3907) accepts one file per request; this wrapper preserves
 * that 1:1 shape and the leaf command loops over multiple paths.
 *
 * Server-side caveats:
 *   - 100 MB hard limit (yaml :3873) — also enforced locally in
 *     `buildFileMultipart` to avoid wasted egress.
 *   - Forbidden file types return 400 (yaml :3883). Allowlist is undocumented;
 *     we don't enforce locally — server is the authority.
 *
 * Spec 0037 §5.2.
 */
export async function uploadFile(
  client: HttpClient,
  opts: UploadFileOpts,
): Promise<UploadFileResult> {
  const raw = await client.requestMultipart({
    path: FILE_UPLOAD_PATH,
    body: opts.multipart.body,
    schema: FileUploadResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return {
    uuid: raw.data.uuid,
    filename: opts.multipart.filename,
    bytes: opts.multipart.bytes,
    raw,
  };
}
