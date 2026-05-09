import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrappers for R30 `projects archive` / `projects activate` (spec 0043).
 *
 * Both endpoints take an empty body and return `SuccessResponse` (per
 * OpenAPI :621-647 for archive, :649-674 for activate). The CLI computes the
 * new state from the verb; the response body carries no information beyond
 * `{ result: 'success' }`.
 *
 * Server-side idempotency:
 *   - `archive`: re-archiving an already-archived project returns 200
 *     (yaml :635 — "is idempotent").
 *   - `activate`: un-archives, un-deletes, OR no-ops (already-active) — all
 *     three return 200 (yaml :662 — "single entry point for both unarchive
 *     and undelete; otherwise no-op returning 200").
 *
 * Spec 0043 §2.1 / §2.2.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `tasks-transition.ts`,
 * `tasks-delete.ts`).
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type ProjectsTransitionVerb = 'archive' | 'activate';

/**
 * Resolve the wire path for a project-transition verb. Exposed so `--dry-run`
 * envelopes can echo the path without re-running this branch.
 */
export function projectsTransitionPath(verb: ProjectsTransitionVerb, projectId: number): string {
  return verb === 'archive' ? `/project/${projectId}/archive` : `/project/${projectId}/activate`;
}

export type ProjectsTransitionOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type ProjectsTransitionResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /project/{project_id}/archive` — moves the project into the archived
 * state (state_id=2). Empty request body. Response is `SuccessResponse`; the
 * CLI does not surface it (it derives `current_state` from the verb).
 *
 * Spec 0043 §2.1 / OpenAPI :621-647.
 */
export async function archiveProject(
  client: HttpClient,
  projectId: number,
  opts: ProjectsTransitionOpts = {},
): Promise<ProjectsTransitionResult> {
  const raw = await client.request({
    method: 'POST',
    path: projectsTransitionPath('archive', projectId),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/**
 * `POST /project/{project_id}/activate` — restores the project into the
 * active state. Single endpoint for both unarchive and undelete; also a 200
 * no-op for already-active projects (yaml :662).
 *
 * Empty request body. Response is `SuccessResponse`; the CLI surfaces
 * `current_state: 'active'` regardless of which transition the server
 * performed (decision 7).
 *
 * **PlanExceededException**: when the caller's plan is at its project cap,
 * the server may reject the activation (likely 422). Surfaces as
 * `FreeloApiError` — the command layer passes the message through (decision 8).
 *
 * Spec 0043 §2.2 / OpenAPI :649-674.
 */
export async function activateProject(
  client: HttpClient,
  projectId: number,
  opts: ProjectsTransitionOpts = {},
): Promise<ProjectsTransitionResult> {
  const raw = await client.request({
    method: 'POST',
    path: projectsTransitionPath('activate', projectId),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
