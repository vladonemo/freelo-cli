import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrappers for R32 `projects workers remove` (spec 0045).
 *
 * Two endpoints:
 *   - `POST /project/{project_id}/remove-workers/by-ids`    (OpenAPI :676-716)
 *   - `POST /project/{project_id}/remove-workers/by-emails` (OpenAPI :718-757)
 *
 * Both are array-bodied: one HTTP call removes many users atomically. The
 * server pre-checks ACL across all ids/emails up-front — if the caller can't
 * remove any single user, the whole request fails (no partial removal,
 * yaml :689-690 / :731). Therefore the CLI does not fan out into N calls;
 * one invocation = one POST.
 *
 * Both return `SuccessResponse` (`{ result: 'success' }`); the CLI does not
 * surface the body (it derives the envelope from input + verb). 4xx responses
 * are NOT special-cased here — they bubble as `FreeloApiError`. v1 does not
 * map any HTTP error to `already_in_target_state: true` (spec 0045 decision 6
 * — the by-emails endpoint explicitly fails on emails-not-in-project, and
 * by-ids isn't documented as idempotent; "don't guess the API").
 *
 * `getProjectWorkers` (the GET side) lives in `src/api/projects.ts` and is
 * reused unchanged from R04.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — mirrors `projects-delete.ts` /
 * `projects-transition.ts`.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type ProjectsWorkersRemoveOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type ProjectsWorkersRemoveResult = {
  raw: ApiResponse<unknown>;
};

export type RemoveByIdsBody = { users_ids: number[] };
export type RemoveByEmailsBody = { users_emails: string[] };

/**
 * Resolve the wire path for `POST /project/{id}/remove-workers/by-ids`.
 * Exposed so `--dry-run` envelopes can echo the path without re-running this
 * branch.
 */
export function projectsWorkersRemoveByIdsPath(projectId: number): string {
  return `/project/${projectId}/remove-workers/by-ids`;
}

/**
 * Resolve the wire path for `POST /project/{id}/remove-workers/by-emails`.
 * Exposed so `--dry-run` envelopes can echo the path without re-running this
 * branch.
 */
export function projectsWorkersRemoveByEmailsPath(projectId: number): string {
  return `/project/${projectId}/remove-workers/by-emails`;
}

/**
 * `POST /project/{id}/remove-workers/by-ids` — atomic array remove.
 *
 * Body shape: `{ users_ids: number[] }`. Server response is
 * `SuccessResponse`; on 4xx the underlying client throws `FreeloApiError`
 * which the command layer surfaces (no idempotent re-classification —
 * spec 0045 decision 6).
 *
 * Spec 0045 §2.2.
 */
export async function removeProjectWorkersByIds(
  client: HttpClient,
  projectId: number,
  body: RemoveByIdsBody,
  opts: ProjectsWorkersRemoveOpts = {},
): Promise<ProjectsWorkersRemoveResult> {
  const raw = await client.request({
    method: 'POST',
    path: projectsWorkersRemoveByIdsPath(projectId),
    body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/**
 * `POST /project/{id}/remove-workers/by-emails` — atomic array remove.
 *
 * Body shape: `{ users_emails: string[] }`. The server resolves emails to
 * user ids and then runs the same ACL/owner check as by-ids; "Every email
 * **must** belong to a user currently in the project — otherwise the request
 * fails" (yaml :731). On 4xx the underlying client throws `FreeloApiError`;
 * v1 surfaces it as-is (spec 0045 decision 6).
 *
 * Spec 0045 §2.3.
 */
export async function removeProjectWorkersByEmails(
  client: HttpClient,
  projectId: number,
  body: RemoveByEmailsBody,
  opts: ProjectsWorkersRemoveOpts = {},
): Promise<ProjectsWorkersRemoveResult> {
  const raw = await client.request({
    method: 'POST',
    path: projectsWorkersRemoveByEmailsPath(projectId),
    body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
