import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  CommentCreatedSchema,
  CommentFullSchema,
  type CommentCreated,
  type CommentFull,
} from './schemas/comment.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

/**
 * Wire wrappers for the `comments` resource group, R16 (spec 0027).
 *
 * Single endpoint in v1: `GET /all-comments` — paginated list of every
 * comment the caller can see, ACL-filtered. Mirrors the structure of
 * `getAllTasks` (R07, spec 0017 §4.3) byte-for-byte.
 */

/** Two-field opts shared by R16's GET wrapper. Mirrors `FetchOpts` in `tasks.ts`. */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * Filter map for `GET /all-comments`. Each field maps 1-1 to a Freelo wire
 * parameter (OpenAPI :2683-2709).
 */
export type AllCommentsFilters = {
  projects?: readonly number[];
  type?: 'all' | 'task' | 'document' | 'file' | 'link';
  orderBy?: 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

export type AllCommentsOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllCommentsFilters;
};

export type CommentsListResult = {
  page: NormalizedPage<CommentFull>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /all-comments?<query>` — paginated; inner key `comments`. Filters
 * compose via `buildQuery` with the bracketed-array convention Freelo expects
 * (e.g. `projects_ids[]=11&projects_ids[]=22`). Spec 0027 §4.2.
 */
export async function getAllComments(
  client: HttpClient,
  opts: AllCommentsOpts,
): Promise<CommentsListResult> {
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
  if (filters.type !== undefined) params['type'] = filters.type;
  if (filters.orderBy !== undefined) params['order_by'] = filters.orderBy;
  if (filters.order !== undefined) params['order'] = filters.order;

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `/all-comments?${qs}` : '/all-comments';
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'comments', CommentFullSchema);
  return { page, raw };
}

/**
 * Compare a comment's date field against the `since` cutoff (parsed once at
 * the call site). Returns `true` when the comment is `>= since` (inclusive).
 *
 * `field` is `'date_add'` (default) or `'date_edited_at'` — whichever the
 * user chose with `--order-by`. When the comment lacks `date_edited_at`, we
 * fall back to `date_add` so the filter still has a basis for comparison.
 *
 * Malformed dates (`Date.parse` returns NaN) are tolerated by including the
 * comment — agents can re-filter downstream if they care about strictness.
 *
 * Spec 0027 §4.3.
 */
/* ---------------------------------------------------------------------------
 *  R17 — `freelo comments add` (spec 0028)
 *
 *  Wire wrapper for `POST /task/{task_id}/comments`. Mirrors
 *  `setTaskDescription` in `src/api/tasks-description.ts` byte-for-byte; only
 *  the validating schema and the path differ.
 *
 *  Note on server-side behavior: the API auto-flips the first POST on a
 *  task with no prior comments to a description (yaml :2589-2592). The
 *  CLI does not branch on this — `is_description` rides through on the
 *  response, the leaf command surfaces it on the envelope.
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/task/{task_id}/comments`. Subset of the
 * OpenAPI request body (yaml :2602-2611) for the v1-supported field set —
 * no `files[]` (multipart upload helper lands at R25).
 */
export type AddCommentBody = {
  content: string;
};

/**
 * CLI-side input shape passed to `buildAddCommentBody`.
 *
 * Distinct from `AddCommentBody` so a future v1.x can grow CLI-ergonomic
 * fields (e.g. `--mention <id>`) without touching the wire shape directly.
 */
export type AddCommentInput = {
  content: string;
};

export type AddCommentOpts = FetchOpts & {
  taskId: number;
  body: AddCommentBody;
};

export type AddCommentResult = {
  comment: CommentCreated;
  raw: ApiResponse<CommentCreated>;
};

/**
 * `POST /task/{task_id}/comments` — create a single comment on a task.
 * Validates the response through `CommentCreatedSchema`; rate-limit and
 * request-id metadata travel on `raw` for the leaf command to surface in
 * the envelope.
 *
 * Spec 0028 §4.
 */
export async function addComment(
  client: HttpClient,
  opts: AddCommentOpts,
): Promise<AddCommentResult> {
  const raw = await client.request({
    method: 'POST',
    path: addCommentPath(opts.taskId),
    body: opts.body,
    schema: CommentCreatedSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { comment: raw.data, raw };
}

/**
 * Resolve the wire path for an add call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running the network branch.
 */
export function addCommentPath(taskId: number): string {
  return `/task/${taskId}/comments`;
}

/**
 * Map CLI input → wire body. Pure function — no I/O.
 *
 * In v1 this is a near-identity: the CLI doesn't accept `files[]` (R25
 * multipart helper). Adding that in R25 is a single-file change here, not a
 * refactor of the leaf command.
 */
export function buildAddCommentBody(input: AddCommentInput): AddCommentBody {
  return { content: input.content };
}

export function commentMatchesSince(
  c: { date_add: string; date_edited_at?: string | null },
  cutoffMs: number,
  field: 'date_add' | 'date_edited_at',
): boolean {
  const raw =
    field === 'date_edited_at'
      ? c.date_edited_at !== undefined && c.date_edited_at !== null && c.date_edited_at.length > 0
        ? c.date_edited_at
        : c.date_add
      : c.date_add;
  const t = Date.parse(raw);
  if (Number.isNaN(t)) return true;
  return t >= cutoffMs;
}
