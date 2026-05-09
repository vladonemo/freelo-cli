import { type ApiResponse, type HttpClient } from './client.js';
import {
  FindTaskRelationsResponseSchema,
  GetTaskRelationsResponseSchema,
  type FindTaskRelationsResponse,
  type GetTaskRelationsResponse,
} from './schemas/task-relations.js';

/**
 * Wire wrappers for R38 `tasks relations` / `tasks find-relations`
 * (spec 0052). Both endpoints are read-only:
 *
 *   - `GET  /task/{task_id}/relations` — single-task relations. OpenAPI
 *     :1943-1969. Response: `{ relations: TaskRelation[] }`. Empty array
 *     is a valid 200.
 *   - `POST /tasks/relations`          — bulk relations across many tasks.
 *     OpenAPI :1614-1660. Body: `{ task_ids: [<int>, ...] }` (1–100).
 *     Response: `{ tasks: [{ task_id, relations }, ...] }`. Tasks the
 *     caller cannot access are silently omitted (yaml :1622).
 *
 * The CLI does NOT create or delete relations — the OpenAPI documents no
 * such endpoint.
 */

export type RelationsOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type GetRelationsResult = {
  raw: ApiResponse<GetTaskRelationsResponse>;
  body: GetTaskRelationsResponse;
};

export type FindRelationsResult = {
  raw: ApiResponse<FindTaskRelationsResponse>;
  body: FindTaskRelationsResponse;
};

/** Path for `GET /task/{task_id}/relations`. */
export function taskRelationsPath(taskId: number): string {
  return `/task/${taskId}/relations`;
}

/** Path for `POST /tasks/relations`. Constant. */
export function findTaskRelationsPath(): string {
  return '/tasks/relations';
}

/**
 * `GET /task/{task_id}/relations` — read all relations on a single task.
 * Caller-inaccessible related tasks are filtered server-side (yaml :1950).
 */
export async function getTaskRelations(
  client: HttpClient,
  taskId: number,
  opts: RelationsOpts = {},
): Promise<GetRelationsResult> {
  const raw = await client.request({
    method: 'GET',
    path: taskRelationsPath(taskId),
    schema: GetTaskRelationsResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `POST /tasks/relations` — bulk-fetch relations for 1–100 task ids in a
 * single call. Tasks the caller cannot access are silently omitted from
 * the response.
 *
 * Caller must guarantee `taskIds.length` is in `[1, 100]`; the command
 * layer enforces this (spec 0052 decision 7).
 */
export async function findTaskRelations(
  client: HttpClient,
  taskIds: readonly number[],
  opts: RelationsOpts = {},
): Promise<FindRelationsResult> {
  const raw = await client.request({
    method: 'POST',
    path: findTaskRelationsPath(),
    body: { task_ids: [...taskIds] },
    schema: FindTaskRelationsResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}
