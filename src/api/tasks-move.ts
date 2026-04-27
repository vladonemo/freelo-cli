import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrapper for R12 `tasks move` (spec 0022).
 *
 * `POST /task/{task_id}/move/{tasklist_id}` — relocates a task into a
 * different tasklist. Cross-project moves work transparently because the
 * destination project is **derived from the destination tasklist id**
 * (OpenAPI :1842-1891, sibling endpoint :1906 confirms the derivation).
 *
 * The endpoint accepts an optional body with `work_reports_action`,
 * `custom_fields_action`, and `multi_project_task.source_tasklist_id` —
 * **all out of scope for R12 v1** (spec 0022 §6 / decision 4). We send an
 * empty body and rely on the API's defaults
 * (`work_reports_action: 'move_to_target_project'`,
 * `custom_fields_action: 'nothing'`).
 *
 * Response: `SuccessResponse` (`{ result: 'success', ... }`). The CLI does
 * not use the body — it derives the new shape from the post-move refresh GET.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `tasks-edit.ts`,
 * `tasks-transition.ts`).
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type MoveTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type MoveTaskResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for a move call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running this branch.
 */
export function movePath(taskId: number, toTasklistId: number): string {
  return `/task/${taskId}/move/${toTasklistId}`;
}

/**
 * `POST /task/{task_id}/move/{tasklist_id}` — execute the move.
 *
 * Empty body (defaults applied server-side). Response is `SuccessResponse`;
 * the CLI fetches the post-move task detail via a refresh GET to surface
 * the new tasklist/project ids.
 *
 * Spec 0022 §2.1 / §3.4.
 */
export async function moveTask(
  client: HttpClient,
  taskId: number,
  toTasklistId: number,
  opts: MoveTaskOpts = {},
): Promise<MoveTaskResult> {
  const raw = await client.request({
    method: 'POST',
    path: movePath(taskId, toTasklistId),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
