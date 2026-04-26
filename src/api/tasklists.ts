import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { TasklistFullSchema, type TasklistFull } from './schemas/tasklist.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';

export type FetchTasklistsOpts = {
  signal?: AbortSignal;
  requestId?: string;
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  /** When set, filter to one project via `?projects_ids[]=<id>`. */
  projectId?: number;
};

export type TasklistsListResult<T> = {
  page: NormalizedPage<T>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /all-tasklists` — paginated; inner key `tasklists`. Optional
 * `?projects_ids[]=<id>` filter for the per-project mode.
 *
 * Spec 0014 §3 / §4.2.
 */
export async function getAllTasklists(
  client: HttpClient,
  opts: FetchTasklistsOpts,
): Promise<TasklistsListResult<TasklistFull>> {
  const params = new URLSearchParams();
  params.set('p', String(opts.page));
  if (opts.projectId !== undefined) {
    params.append('projects_ids[]', String(opts.projectId));
  }
  const raw = await client.request({
    method: 'GET',
    path: `/all-tasklists?${params.toString()}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'tasklists', TasklistFullSchema);
  return { page, raw };
}
