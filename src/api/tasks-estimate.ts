import { type ApiResponse, type HttpClient } from './client.js';
import { EstimateResponseSchema } from './schemas/task-estimate.js';

/**
 * Wire wrappers for R37 `tasks estimate` (spec 0051).
 *
 *   - `POST   /task/{task_id}/total-time-estimate`        — total upsert.
 *     OpenAPI :2254-2289. Body: `{ minutes: <int> }`.
 *   - `DELETE /task/{task_id}/total-time-estimate`        — total clear.
 *     OpenAPI :2290-2309. No body. 200 even when no estimate (yaml :2299).
 *   - `POST   /task/{task_id}/users-time-estimates/{user_id}` — per-user upsert.
 *     OpenAPI :2311-2352. Body: `{ minutes: <int> }`. ACL-filtered (yaml :2326).
 *   - `DELETE /task/{task_id}/users-time-estimates/{user_id}` — per-user clear.
 *     OpenAPI :2353-2377. No body. 200 even when no estimate (yaml :2362).
 *
 * Per-user does NOT auto-update the total (yaml :2325) — managed
 * separately. The CLI does not aggregate.
 *
 * The CLI does **not** rely on a 404 on DELETE to detect already-cleared:
 * the documented behavior is 200 either way. The defensive 404 catch lives
 * at the command layer (mirrors `tasks-reminder.ts` / R35) for forward-compat.
 */

export type SetEstimateOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type SetEstimateResult = {
  raw: ApiResponse<unknown>;
};

export type ClearEstimateOpts = SetEstimateOpts;
export type ClearEstimateResult = SetEstimateResult;

/**
 * Resolve the total-estimate path. Exposed so `--dry-run` envelopes can echo
 * the path without re-running the live branch.
 */
export function totalEstimatePath(taskId: number): string {
  return `/task/${taskId}/total-time-estimate`;
}

/**
 * Resolve the per-user estimate path. Exposed so `--dry-run` envelopes can
 * echo the path without re-running the live branch.
 */
export function userEstimatePath(taskId: number, userId: number): string {
  return `/task/${taskId}/users-time-estimates/${userId}`;
}

/**
 * `POST` to either the total or per-user path, depending on `userId`.
 *
 * Body `{ minutes: <int> }`. Server upserts on every call (yaml :2267,
 * :2324) — a second call overwrites the prior value. Caller must guarantee
 * `minutes >= 1` (the command layer enforces this).
 */
export async function setEstimate(
  client: HttpClient,
  taskId: number,
  minutes: number,
  userId: number | null,
  opts: SetEstimateOpts = {},
): Promise<SetEstimateResult> {
  const path = userId === null ? totalEstimatePath(taskId) : userEstimatePath(taskId, userId);
  const raw = await client.request({
    method: 'POST',
    path,
    body: { minutes },
    schema: EstimateResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/**
 * `DELETE` on either the total or per-user path, depending on `userId`.
 *
 * Empty body. Server returns 200 with `SuccessResponse` even when no
 * estimate was set (yaml :2299, :2362 — idempotent). The defensive 404
 * path is handled at the command layer, not here.
 */
export async function clearEstimate(
  client: HttpClient,
  taskId: number,
  userId: number | null,
  opts: ClearEstimateOpts = {},
): Promise<ClearEstimateResult> {
  const path = userId === null ? totalEstimatePath(taskId) : userEstimatePath(taskId, userId);
  const raw = await client.request({
    method: 'DELETE',
    path,
    schema: EstimateResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
