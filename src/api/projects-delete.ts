import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrapper for R30 `projects delete` (spec 0043).
 *
 * `DELETE /project/{id}` — soft-deletes the project. OpenAPI :557-581.
 *
 * No request body. Response is `SuccessResponse`; the CLI does not surface
 * the body (it derives `current_state` from the verb).
 *
 * **404 idempotency**: a DELETE that returns 404 is treated as success-with-
 * `already_in_target_state: true` by the command layer (see
 * `src/commands/projects/delete.ts`, mirrors R13 `tasks/delete.ts`). This
 * wrapper does NOT special-case 404 — it lets `FreeloApiError`
 * (`code: 'NOT_FOUND'`) bubble; the command catches and re-classifies. Keeps
 * the wire-layer simple and reusable.
 *
 * **Soft-delete reversibility**: the project row stays; `POST /project/{id}/activate`
 * restores it (yaml :569). The destructive blast radius is therefore narrow —
 * the prompt copy reflects this.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — mirrors `tasks-delete.ts`.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type DeleteProjectOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type DeleteProjectResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for a `projects delete` call. Exposed so `--dry-run`
 * envelopes can echo the path without re-running this branch.
 */
export function projectDeletePath(projectId: number): string {
  return `/project/${projectId}`;
}

/**
 * `DELETE /project/{id}` — soft-delete a project.
 *
 * Empty body (no Content-Type header set — see `client.ts`). Response is
 * `SuccessResponse`; on 404, the underlying client throws `FreeloApiError`
 * with `code: 'NOT_FOUND'` which the command layer re-classifies as
 * idempotent already-deleted.
 *
 * Spec 0043 §2.3 / §3.3.
 */
export async function deleteProject(
  client: HttpClient,
  projectId: number,
  opts: DeleteProjectOpts = {},
): Promise<DeleteProjectResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: projectDeletePath(projectId),
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
