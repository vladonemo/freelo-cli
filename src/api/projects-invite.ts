import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { type ProjectsInviteBody, type ProjectsInviteResult } from './schemas/project.js';

/**
 * Wire wrapper for R33 `projects invite` (spec 0046).
 *
 * Endpoint:
 *   - `POST /users/manage-workers` (yaml :3417-3498)
 *
 * Single bulk POST: one invocation = one HTTP call. The body carries arrays
 * for all three input dimensions (projects, users, emails); the server
 * resolves emails to ids server-side and may create users for unknown emails
 * (yaml :3433). Response surfaces four buckets — see
 * `ProjectsInviteResult` in `src/api/schemas/project.ts` for shape rationale.
 *
 * 4xx responses are NOT special-cased here — they bubble as `FreeloApiError`.
 * v1 does not map any HTTP error to `already_in_target_state: true`
 * (spec 0046 decision 7 — server's own `newly_invited_users_to_projects`
 * already discriminates re-invites).
 */

/**
 * Loose response schema. All four buckets are defaulted to `[]` so the
 * envelope shape is stable even if the server elides empty arrays.
 *
 * `.passthrough()` on each item schema tolerates undocumented fields without
 * dropping them.
 */
const InviteResultSchema = z
  .object({
    newly_invited_users_to_projects: z.array(z.unknown()).default([]),
    newly_created_users: z
      .array(
        z
          .object({
            id: z.number().int().optional(),
            email: z.string().nullable().optional(),
          })
          .passthrough(),
      )
      .default([]),
    newly_invited_users: z
      .array(
        z
          .object({
            id: z.number().int().optional(),
            email: z.string().nullable().optional(),
            projects_ids: z.array(z.number().int()).optional(),
          })
          .passthrough(),
      )
      .default([]),
    removed_users_from_projects: z.array(z.unknown()).default([]),
  })
  .passthrough();

export type InviteUsersOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type InviteUsersResult = {
  result: ProjectsInviteResult;
  raw: ApiResponse<ProjectsInviteResult>;
};

/**
 * Resolve the wire path for `POST /users/manage-workers`. Exposed so
 * `--dry-run` envelopes can echo the path without re-running this branch.
 *
 * Spec 0046 §3.3 / §5.3.
 */
export function projectsInvitePath(): '/users/manage-workers' {
  return '/users/manage-workers';
}

/**
 * `POST /users/manage-workers` — bulk invite users (existing by id, new by
 * email) to one or more projects in a single request.
 *
 * Body shape: `{ projects_ids: number[], users_ids?: number[], emails?: string[] }`.
 * Server response is parsed via `InviteResultSchema`; on 4xx the underlying
 * client throws `FreeloApiError` which the command layer surfaces (no
 * idempotent re-classification — spec 0046 decision 7).
 *
 * Spec 0046 §5.3.
 */
export async function inviteUsersToProjects(
  client: HttpClient,
  body: ProjectsInviteBody,
  opts: InviteUsersOpts = {},
): Promise<InviteUsersResult> {
  const raw = await client.request({
    method: 'POST',
    path: projectsInvitePath(),
    body,
    schema: InviteResultSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  // The zod-output type has `id?: number | undefined` (literal undefined) on
  // each user record; the public `ProjectsInviteResult` uses
  // `id?: number` (no `| undefined`) because of `exactOptionalPropertyTypes`.
  // The runtime shapes are identical — `undefined` in zod's output is the
  // same as the property being absent. Cast at the boundary.
  const result = raw.data as unknown as ProjectsInviteResult;
  const apiResp = raw as unknown as ApiResponse<ProjectsInviteResult>;
  return { result, raw: apiResp };
}
