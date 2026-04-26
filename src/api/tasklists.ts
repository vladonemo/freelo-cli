import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  TasklistFullSchema,
  TasklistDetailSchema,
  type TasklistFull,
  type TasklistDetail,
} from './schemas/tasklist.js';
import { UserBasicSchema, type UserBasic } from './schemas/project.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';

/**
 * Two-field opts shared by R06's GET wrappers. Mirrors the `FetchOpts` type
 * declared in `src/api/projects.ts` (R04). A future refactor may promote
 * this to a shared module once a third consumer appears.
 */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

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

/* ---------------------------------------------------------------------------
 *  R06 — `freelo tasklists show <id>` (spec 0016)
 * ------------------------------------------------------------------------- */

/**
 * `GET /tasklist/{id}` — returns the `TasklistDetail` shape (single object,
 * NOT paginated). Carries a top-level `project_id` field that R06 reads to
 * construct the `/assignable-workers` URL.
 *
 * OpenAPI :1264-1288. Spec 0016 §4.3.
 */
export async function getTasklistDetail(
  client: HttpClient,
  tasklistId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TasklistDetail>> {
  return client.request({
    method: 'GET',
    path: `/tasklist/${tasklistId}`,
    schema: TasklistDetailSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
}

/**
 * `GET /project/{project_id}/tasklist/{tasklist_id}/assignable-workers` —
 * returns a **bare `UserBasic[]` array**, NOT a paginated wrapper. Materially
 * different from R04's `/project/{id}/workers` (which IS paginated). One
 * round-trip returns the full list.
 *
 * OpenAPI :1235-1262. Spec 0016 §4.3 / decision 1.
 */
export async function getAssignableWorkers(
  client: HttpClient,
  projectId: number,
  tasklistId: number,
  opts: FetchOpts,
): Promise<ApiResponse<UserBasic[]>> {
  return client.request({
    method: 'GET',
    path: `/project/${projectId}/tasklist/${tasklistId}/assignable-workers`,
    schema: z.array(UserBasicSchema),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
}
