import { type ApiResponse, type HttpClient } from './client.js';
import {
  AssignTaskToProjectResponseSchema,
  RemoveTaskFromProjectResponseSchema,
  type AssignTaskToProjectResponse,
} from './schemas/task-projects.js';

/**
 * Wire wrappers for R38 `tasks project add` / `tasks project remove`
 * (spec 0052).
 *
 *   - `POST   /task/{task_id}/projects`               — assign task to a
 *     secondary project. OpenAPI :1893-1941. Body: `{ tasklist_id: <int> }`
 *     (single — see spec decision 3 for fan-out semantics). Response carries
 *     the **child task** id and uuid (yaml :1923-1937).
 *   - `DELETE /task/{task_id}/projects/{project_id}` — remove task from a
 *     secondary project. OpenAPI :1971-2000. Empty body. 200 on success;
 *     403 if attempting to remove the primary project (yaml :1984); 404 if
 *     the task is not in the given project (yaml :1985 — first-class
 *     idempotency signal, surfaced as `already_in_target_state: true` at
 *     the command layer).
 */

export type AssignTaskOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type AssignTaskResult = {
  raw: ApiResponse<AssignTaskToProjectResponse>;
  body: AssignTaskToProjectResponse;
};

export type RemoveTaskOpts = AssignTaskOpts;

export type RemoveTaskResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the path for `POST /task/{id}/projects`. Exposed so `--dry-run`
 * envelopes can echo the path without re-running the live branch.
 */
export function assignTaskPath(taskId: number): string {
  return `/task/${taskId}/projects`;
}

/**
 * Resolve the path for `DELETE /task/{id}/projects/{project_id}`. Exposed so
 * `--dry-run` envelopes can echo the path without re-running the live branch.
 */
export function removeTaskFromProjectPath(taskId: number, projectId: number): string {
  return `/task/${taskId}/projects/${projectId}`;
}

/**
 * `POST /task/{task_id}/projects` — assign a task to a secondary project
 * (creates a child task in the project derived from `tasklist_id`).
 *
 * Body: `{ tasklist_id: <int> }`. The CLI fans out repeated `--tasklist`
 * values into N sequential calls (spec 0052 decision 3); this wrapper
 * handles one POST.
 */
export async function assignTaskToProject(
  client: HttpClient,
  taskId: number,
  tasklistId: number,
  opts: AssignTaskOpts = {},
): Promise<AssignTaskResult> {
  const raw = await client.request({
    method: 'POST',
    path: assignTaskPath(taskId),
    body: { tasklist_id: tasklistId },
    schema: AssignTaskToProjectResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `DELETE /task/{task_id}/projects/{project_id}` — remove the task from a
 * secondary project. No body. Server returns 200 on success, 403 if the
 * caller tries to remove the primary project (use `tasks delete` instead),
 * 404 if the task is not present in that project.
 *
 * The defensive 404 → already-removed mapping lives at the command layer.
 */
export async function removeTaskFromProject(
  client: HttpClient,
  taskId: number,
  projectId: number,
  opts: RemoveTaskOpts = {},
): Promise<RemoveTaskResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: removeTaskFromProjectPath(taskId, projectId),
    schema: RemoveTaskFromProjectResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
