import { type ApiResponse, type HttpClient } from './client.js';
import {
  ShareTaskResponseSchema,
  UnshareTaskResponseSchema,
  type ShareTaskResponse,
} from './schemas/task-share.js';

/**
 * Wire wrappers for R36 `tasks share` / `tasks unshare` (spec 0050).
 *
 *   - `GET    /public-link/task/{task_id}` — get-or-create the task's
 *     public URL. OpenAPI :2137-2165. Idempotent on the wire: first call
 *     creates, subsequent calls return the same URL (yaml :2150). The
 *     CLI cannot distinguish first-vs-Nth call, so the envelope's
 *     `created` field stays `null` (spec 0050 decision 2).
 *   - `DELETE /public-link/task/{task_id}` — revoke the public URL.
 *     OpenAPI :2166-2185. The OpenAPI is silent on the no-link case;
 *     the command layer maps a 404 to `already_in_target_state: true`
 *     for forward-compat (spec 0050 decision 5).
 */

export type ShareTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type ShareTaskResult = {
  raw: ApiResponse<ShareTaskResponse>;
  body: ShareTaskResponse;
};

export type UnshareTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type UnshareTaskResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for both verbs. Exposed so `--dry-run` envelopes
 * can echo the path without re-running the live branch.
 */
export function publicLinkPath(taskId: number): string {
  return `/public-link/task/${taskId}`;
}

/**
 * `GET /public-link/task/{task_id}` — get (or create) the public share URL.
 *
 * The "GET that creates" verb is per the OpenAPI (spec 0050 decision 1).
 * No body. 200 carries `{ url: string }`; the schema layer rejects 200
 * responses without a `url`, surfacing a `FreeloApiError` (VALIDATION_ERROR).
 */
export async function shareTask(
  client: HttpClient,
  taskId: number,
  opts: ShareTaskOpts = {},
): Promise<ShareTaskResult> {
  const raw = await client.request({
    method: 'GET',
    path: publicLinkPath(taskId),
    schema: ShareTaskResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `DELETE /public-link/task/{task_id}` — revoke the public share URL.
 *
 * Empty body. Server returns 200 with `SuccessResponse` on the live path
 * (link existed, deleted). The defensive 404 → already-revoked mapping
 * lives at the command layer, not here.
 */
export async function unshareTask(
  client: HttpClient,
  taskId: number,
  opts: UnshareTaskOpts = {},
): Promise<UnshareTaskResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: publicLinkPath(taskId),
    schema: UnshareTaskResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
