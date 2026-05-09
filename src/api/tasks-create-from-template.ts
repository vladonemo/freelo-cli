import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskFromTemplateSchema,
  type CreateTaskFromTemplateBody,
  type CreateTaskFromTemplateInput,
  type TaskFromTemplate,
} from './schemas/task-create-from-template.js';

/**
 * Wire wrapper for R39 `freelo tasks create-from-template` (spec 0053).
 *
 *   - `POST /task/create-from-template/{template_id}` — copy a single task
 *     out of a project template into a destination tasklist. OpenAPI
 *     :2187-2253. Body: `{ task_id, target_project_id?, target_tasklist_id?,
 *     preset_date_from?, users_ids? }`. Response: `{ id, name, tasklist: {
 *     id, name } }`.
 *
 *   The wrapper mirrors `src/api/tasklists-create-from-template.ts`
 *   one-for-one — only the wire path, body field name (`task_id` not
 *   `tasklist_id`), and response schema differ. See spec 0053 §3.2.
 */

/**
 * Map the CLI input (camel-case, already-validated) to the Freelo wire body
 * for `POST /task/create-from-template/{template_id}` (yaml :2214-2233).
 *
 * Pure function — no I/O, no global state. Easy to unit-test without MSW.
 *
 * Mappings:
 *   - `sourceTaskId` → `task_id` (required; the source task id INSIDE the
 *     template referenced by path `template_id`).
 *   - `targetProjectId` → `target_project_id` (omitted when undefined).
 *   - `targetTasklistId` → `target_tasklist_id` (omitted when undefined).
 *   - `dateStart` → `preset_date_from` (already validated as `YYYY-MM-DD`).
 *   - `workers` → `users_ids` (omitted when undefined OR empty array — empty
 *     means "no workers specified", same convention as R31 / spec 0047).
 *
 * Spec 0053 §3.2.
 */
export function buildCreateTaskFromTemplateBody(
  input: CreateTaskFromTemplateInput,
): CreateTaskFromTemplateBody {
  const body: CreateTaskFromTemplateBody = {
    task_id: input.sourceTaskId,
  };
  if (input.targetProjectId !== undefined) {
    body.target_project_id = input.targetProjectId;
  }
  if (input.targetTasklistId !== undefined) {
    body.target_tasklist_id = input.targetTasklistId;
  }
  if (input.dateStart !== undefined) {
    body.preset_date_from = input.dateStart;
  }
  if (input.workers !== undefined && input.workers.length > 0) {
    body.users_ids = [...input.workers];
  }
  return body;
}

/**
 * Build the wire path for `POST /task/create-from-template/{template_id}`.
 * Centralised so `--dry-run` echoes the same string without rebuilding it.
 * Caller is responsible for validating `templateId` is a positive integer
 * (the CLI does this via `parseTemplateIdArg`). No URL-encoding needed —
 * integer.
 */
export function createTaskFromTemplatePath(templateId: number): string {
  return `/task/create-from-template/${templateId}`;
}

export type CreateTaskFromTemplateOpts = {
  templateId: number;
  body: CreateTaskFromTemplateBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateTaskFromTemplateResult = {
  task: TaskFromTemplate;
  raw: ApiResponse<TaskFromTemplate>;
};

/**
 * `POST /task/create-from-template/{template_id}` — copy a template task
 * into a destination tasklist (or a new project, if `target_project_id` is
 * omitted). Validates the response through `TaskFromTemplateSchema`;
 * rate-limit / request-id metadata live on `raw` for the leaf command to
 * surface in the envelope.
 *
 * Spec 0053 §3.2 / yaml :2187-2253.
 */
export async function createTaskFromTemplate(
  client: HttpClient,
  opts: CreateTaskFromTemplateOpts,
): Promise<CreateTaskFromTemplateResult> {
  const raw = await client.request({
    method: 'POST',
    path: createTaskFromTemplatePath(opts.templateId),
    body: opts.body,
    schema: TaskFromTemplateSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { task: raw.data, raw };
}
