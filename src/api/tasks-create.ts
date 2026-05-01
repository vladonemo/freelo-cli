import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskCreatedSchema,
  type CreateTaskBody,
  type CreateTaskInput,
  type TaskCreated,
} from './schemas/task.js';

/**
 * Map the CLI input shape (`--priority high`, `--due 2026-05-01`, …) to the
 * Freelo wire shape `TaskCreate` (OpenAPI :5300-5337).
 *
 * Pure function — no I/O, no global state. Easy to unit-test.
 *
 * Mappings:
 *   - `priority`: low → l, normal → m, high → h (Freelo `priority_enum`).
 *   - `due`: `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00Z` (decision 1, spec 0019 §5).
 *   - `description`: passed inline as `comment.content`.
 *
 * Labels are **never** placed on this body (spec 0041 §5.1): the live
 * `POST /project/{p}/tasklist/{t}/tasks` endpoint rejects name-mode labels
 * with HTTP 400 ("Missing item 'uuid' in array."). The command layer carries
 * `input.labels` out-of-band and dispatches a follow-up
 * `POST /task-labels/add-to-task/{newId}` after the create succeeds. The
 * `labels` field on `CreateTaskInput` is therefore intentionally ignored
 * here — the builder is the sole writer for the wire body, and dropping the
 * mapping is the fix.
 *
 * Fields are emitted only when set (mirrors R07's filter-omit convention).
 *
 * Spec 0019 §5 + spec 0041 §5.1.
 */
export function buildCreateTaskBody(input: CreateTaskInput): CreateTaskBody {
  const body: CreateTaskBody = { name: input.name };
  if (input.due !== undefined) {
    body.due_date = `${input.due}T00:00:00Z`;
  }
  if (input.worker !== undefined) {
    body.worker = input.worker;
  }
  if (input.priority !== undefined) {
    body.priority_enum = input.priority === 'low' ? 'l' : input.priority === 'normal' ? 'm' : 'h';
  }
  if (input.description !== undefined && input.description.length > 0) {
    body.comment = { content: input.description };
  }
  return body;
}

export type CreateTaskOpts = {
  projectId: number;
  tasklistId: number;
  body: CreateTaskBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateTaskResult = {
  task: TaskCreated;
  raw: ApiResponse<TaskCreated>;
};

/**
 * `POST /project/{p}/tasklist/{t}/tasks` — creates a task. Validates the
 * response through `TaskCreatedSchema`; the rate-limit / request-id metadata
 * live on `raw` for the leaf command to surface in the envelope.
 *
 * Spec 0019 §3.3 / OpenAPI :1402-1434.
 */
export async function createTask(
  client: HttpClient,
  opts: CreateTaskOpts,
): Promise<CreateTaskResult> {
  const path = `/project/${opts.projectId}/tasklist/${opts.tasklistId}/tasks`;
  const raw = await client.request({
    method: 'POST',
    path,
    body: opts.body,
    schema: TaskCreatedSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { task: raw.data, raw };
}

/** Convenience: the path the wire call would hit (used by `--dry-run`). */
export function createTaskPath(projectId: number, tasklistId: number): string {
  return `/project/${projectId}/tasklist/${tasklistId}/tasks`;
}
