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

import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  FileItemSchema,
  FileUploadResponseSchema,
  type FileItem,
  type FileItemType,
  type FileUploadResponse,
} from './schemas/file.js';
import { type MultipartFile } from '../lib/multipart.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

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

/* ---------------------------------------------------------------------------
 *  R26 — `freelo files list`  (spec 0038)
 *
 *  Wire endpoint: `GET /all-docs-and-files` (yaml :3909-3954). Paginated;
 *  inner key `items`. The endpoint does NOT accept a task filter — only
 *  `projects_ids[]`, `type`, and `p`. `--task` was deferred at spec time
 *  (decision 01).
 * ------------------------------------------------------------------------- */

/** Path constant — exposed so callers can echo it without a wire call. */
export const ALL_DOCS_AND_FILES_PATH = '/all-docs-and-files';

/**
 * Filter map for `GET /all-docs-and-files`. Each field maps 1-1 to a Freelo
 * wire parameter (OpenAPI `:3925-3937`):
 *
 *   - `projects` → `projects_ids[]`
 *   - `type`     → `type` (single value; wire enum)
 */
export type AllDocsAndFilesFilters = {
  projects?: readonly number[];
  type?: FileItemType;
};

export type AllDocsAndFilesOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllDocsAndFilesFilters;
};

export type FilesListResult = {
  page: NormalizedPage<FileItem>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /all-docs-and-files?<query>` — paginated list of every directory,
 * link, file, and document the caller can see (ACL-filtered server-side).
 *
 * Mirrors `getWorkReports` / `getAllComments` — the schema parses to
 * `unknown`, then `normalizePaginated` validates the wrapper + per-item
 * shape against `FileItemSchema` and returns a `NormalizedPage`.
 *
 * Spec 0038 §4.2.
 */
export async function getAllDocsAndFiles(
  client: HttpClient,
  opts: AllDocsAndFilesOpts,
): Promise<FilesListResult> {
  const { filters } = opts;
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = {
    p: opts.page,
  };
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.type !== undefined) {
    params['type'] = filters.type;
  }

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `${ALL_DOCS_AND_FILES_PATH}?${qs}` : ALL_DOCS_AND_FILES_PATH;
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'items', FileItemSchema);
  return { page, raw };
}
