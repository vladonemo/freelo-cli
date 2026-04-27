import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { CommentFullSchema, type CommentFull } from './schemas/comment.js';
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
