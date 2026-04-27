import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrapper for R13 `tasks delete` (spec 0024).
 *
 * `DELETE /task/{task_id}` — soft-deletes a task. OpenAPI :1697-1714.
 *
 * Empty request body. Response is `SuccessResponse`; the CLI does not surface
 * the body (it derives `current_state` from the verb).
 *
 * **404 idempotency**: a DELETE that returns 404 is treated as success-with-
 * `already_in_target_state: true` by the command layer (see
 * `src/commands/tasks/delete.ts`). This wrapper does NOT special-case 404 —
 * it lets `FreeloApiError` (`code: 'NOT_FOUND'`) bubble; the command catches
 * and re-classifies. Keeps the wire-layer simple and reusable.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `tasks-edit.ts`,
 * `tasks-transition.ts`, `tasks-move.ts`).
 *
 * For DELETE, Freelo may return either a 200 with body `{ result: 'success' }`
 * OR a 204 No Content. The HttpClient parses the JSON body unconditionally;
 * a 204 with empty body would surface as a JSON-parse error. The OpenAPI
 * spec documents a 200 + JSON body for `DELETE /task/{id}` (:1701) so we
 * trust that contract.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type DeleteTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type DeleteTaskResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for a delete call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running this branch.
 */
export function deletePath(taskId: number): string {
  return `/task/${taskId}`;
}

/**
 * `DELETE /task/{task_id}` — soft-delete a task.
 *
 * Empty body (no Content-Type header set — see `client.ts:114`). Response is
 * `SuccessResponse`; on 404, the underlying client throws `FreeloApiError`
 * with `code: 'NOT_FOUND'` which the command layer re-classifies as
 * idempotent already-deleted.
 *
 * Spec 0024 §2.1 / §3.4.
 */
export async function deleteTask(
  client: HttpClient,
  taskId: number,
  opts: DeleteTaskOpts = {},
): Promise<DeleteTaskResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deletePath(taskId),
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
