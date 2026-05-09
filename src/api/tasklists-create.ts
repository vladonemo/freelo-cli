import { type ApiResponse, type HttpClient } from './client.js';
import {
  TasklistWithBudgetSchema,
  type CreateTasklistBody,
  type CreateTasklistInput,
  type TasklistWithBudget,
} from './schemas/tasklist.js';

/**
 * Map the CLI input shape (`--project`, `--name`, `--budget`) to the Freelo
 * wire body for `POST /project/{project_id}/tasklists` (yaml :1158-1171).
 *
 * Pure function — no I/O, no global state. Easy to unit-test without MSW.
 *
 * Mappings:
 *   - `name`: passthrough.
 *   - `budget`: passthrough as a verbatim string (already validated `^[0-9]+$`
 *     by the CLI flag parser); omitted when undefined.
 *
 * Fields are emitted only when set (mirrors R29's `buildCreateProjectBody`).
 *
 * Spec 0047 §5.2.
 */
export function buildCreateTasklistBody(input: CreateTasklistInput): CreateTasklistBody {
  const body: CreateTasklistBody = { name: input.name };
  if (input.budget !== undefined) {
    body.budget = input.budget;
  }
  return body;
}

/**
 * Build the wire path for `POST /project/{project_id}/tasklists`. Centralised
 * so `--dry-run` echoes the same string without rebuilding it. Caller is
 * responsible for validating `projectId` is a positive integer (the CLI does
 * this via `parseProjectFlag`). No URL-encoding needed — integer.
 */
export function createTasklistPath(projectId: number): string {
  return `/project/${projectId}/tasklists`;
}

export type CreateTasklistOpts = {
  projectId: number;
  body: CreateTasklistBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateTasklistResult = {
  tasklist: TasklistWithBudget;
  raw: ApiResponse<TasklistWithBudget>;
};

/**
 * `POST /project/{project_id}/tasklists` — creates a tasklist in the project.
 * Validates the response through `TasklistWithBudgetSchema`; rate-limit /
 * request-id metadata live on `raw` for the leaf command to surface in the
 * envelope.
 *
 * Spec 0047 §5.2 / yaml :1140-1178.
 */
export async function createTasklist(
  client: HttpClient,
  opts: CreateTasklistOpts,
): Promise<CreateTasklistResult> {
  const raw = await client.request({
    method: 'POST',
    path: createTasklistPath(opts.projectId),
    body: opts.body,
    schema: TasklistWithBudgetSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { tasklist: raw.data, raw };
}
