import { type ApiResponse, type HttpClient } from './client.js';
import {
  ProjectBasicSchema,
  type CreateProjectBody,
  type CreateProjectInput,
  type ProjectBasic,
} from './schemas/project.js';

/**
 * Map the CLI input shape (`--name`, `--currency`, `--project-owner-id`) to
 * the Freelo wire shape `POST /projects` body (OpenAPI :206-227).
 *
 * Pure function — no I/O, no global state. Easy to unit-test.
 *
 * Mappings:
 *   - `name`: passthrough.
 *   - `currency`: passthrough as `currency_iso` (CLI flag normalizes to upper-
 *     case before reaching this builder; see `src/commands/projects/create.ts`).
 *   - `projectOwnerId`: passthrough as `project_owner_id`; omitted when undefined.
 *
 * Fields are emitted only when set (mirrors the R09 `buildCreateTaskBody`
 * convention).
 *
 * Spec 0042 §5.
 */
export function buildCreateProjectBody(input: CreateProjectInput): CreateProjectBody {
  const body: CreateProjectBody = {
    name: input.name,
    currency_iso: input.currency,
  };
  if (input.projectOwnerId !== undefined) {
    body.project_owner_id = input.projectOwnerId;
  }
  return body;
}

export type CreateProjectOpts = {
  body: CreateProjectBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateProjectResult = {
  project: ProjectBasic;
  raw: ApiResponse<ProjectBasic>;
};

/**
 * `POST /projects` — creates a project. Validates the response through
 * `ProjectBasicSchema`; the rate-limit / request-id metadata live on `raw`
 * for the leaf command to surface in the envelope.
 *
 * Spec 0042 §5 / OpenAPI :189-234.
 */
export async function createProject(
  client: HttpClient,
  opts: CreateProjectOpts,
): Promise<CreateProjectResult> {
  const raw = await client.request({
    method: 'POST',
    path: createProjectPath,
    body: opts.body,
    schema: ProjectBasicSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { project: raw.data, raw };
}

/**
 * Convenience: the wire path. Used by `--dry-run` so the envelope's
 * `would.path` is computed in one place. Spec 0042 §3.2.
 */
export const createProjectPath = '/projects';
