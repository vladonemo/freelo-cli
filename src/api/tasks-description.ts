import { type ApiResponse, type HttpClient } from './client.js';
import { TaskCommentSchema, type TaskComment } from './schemas/task.js';
import { type SetDescriptionBody, type SetDescriptionInput } from './schemas/task-description.js';

/**
 * Wire wrapper for R15 — `freelo tasks description set`.
 *
 * `GET /task/{task_id}/description` (`getTaskDescription`) is **already declared**
 * in `src/api/tasks.ts:187` (R08, spec 0018). R15 reuses it byte-for-byte; only
 * the new POST wrapper lands here.
 *
 * Spec 0026 §4.3.
 */

/**
 * `POST /task/{task_id}/description` request options.
 *
 * Body type is `SetDescriptionBody` — `{ content }`. `files[]` is out of
 * scope for v1 (R25 multipart helper).
 */
export type SetDescriptionOpts = {
  taskId: number;
  body: SetDescriptionBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type SetDescriptionResult = {
  comment: TaskComment;
  raw: ApiResponse<TaskComment>;
};

/**
 * `POST /task/{task_id}/description` — create or replace (upsert) the task
 * description. Validates the response through `TaskCommentSchema`; rate-limit
 * / request-id metadata live on `raw` for the leaf command to surface in the
 * envelope.
 *
 * Upsert semantics: first call creates, subsequent call **replaces** the
 * content entirely. No append, no history (`docs/api/freelo-api.yaml:2039`).
 *
 * Spec 0026 §2.2.
 */
export async function setTaskDescription(
  client: HttpClient,
  opts: SetDescriptionOpts,
): Promise<SetDescriptionResult> {
  const raw = await client.request({
    method: 'POST',
    path: setDescriptionPath(opts.taskId),
    body: opts.body,
    schema: TaskCommentSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { comment: raw.data, raw };
}

/**
 * Resolve the wire path for a set call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running the network branch.
 */
export function setDescriptionPath(taskId: number): string {
  return `/task/${taskId}/description`;
}

/**
 * Map CLI input → wire body. Pure function — no I/O.
 *
 * In v1 this is a near-identity: the CLI doesn't accept `files[]` (R25
 * multipart helper) so the body is just `{ content }`. The function exists so
 * that adding `files` in R25 is a single-file change here, not a refactor of
 * the leaf command.
 */
export function buildSetDescriptionBody(input: SetDescriptionInput): SetDescriptionBody {
  return { content: input.content };
}
