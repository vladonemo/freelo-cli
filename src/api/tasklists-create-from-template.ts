import { type ApiResponse, type HttpClient } from './client.js';
import {
  TasklistFromTemplateSchema,
  type CreateTasklistFromTemplateBody,
  type CreateTasklistFromTemplateInput,
  type TasklistFromTemplate,
} from './schemas/tasklist.js';

/**
 * Map the CLI input (camel-case, already-validated) to the Freelo wire body
 * for `POST /tasklist/create-from-template/{template_id}` (yaml :1315-1337).
 *
 * Pure function — no I/O, no global state. Easy to unit-test without MSW.
 *
 * Mappings:
 *   - `sourceTasklistId` → `tasklist_id` (required; the source tasklist ID
 *     INSIDE the template project — yaml :1303 documents the deliberate
 *     path/body ID interleaving).
 *   - `targetProjectId` → `target_project_id` (omitted when undefined).
 *   - `targetTasklistId` → `target_tasklist_id` (omitted when undefined).
 *   - `dateStart` → `preset_date_from` (already validated as `YYYY-MM-DD`).
 *   - `workers` → `users_ids` (omitted when undefined OR empty array — empty
 *     means "no workers specified", same convention as R31).
 *
 * Spec 0047 §5.2.
 */
export function buildCreateTasklistFromTemplateBody(
  input: CreateTasklistFromTemplateInput,
): CreateTasklistFromTemplateBody {
  const body: CreateTasklistFromTemplateBody = {
    tasklist_id: input.sourceTasklistId,
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
 * Build the wire path for `POST /tasklist/create-from-template/{template_id}`.
 * Centralised so `--dry-run` echoes the same string without rebuilding it.
 * Caller is responsible for validating `templateId` is a positive integer
 * (the CLI does this via `parseTemplateIdArg`). No URL-encoding needed —
 * integer.
 */
export function createTasklistFromTemplatePath(templateId: number): string {
  return `/tasklist/create-from-template/${templateId}`;
}

export type CreateTasklistFromTemplateOpts = {
  templateId: number;
  body: CreateTasklistFromTemplateBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateTasklistFromTemplateResult = {
  tasklist: TasklistFromTemplate;
  raw: ApiResponse<TasklistFromTemplate>;
};

/**
 * `POST /tasklist/create-from-template/{template_id}` — clones a tasklist
 * from a project template into a target project (or a new one if
 * `target_project_id` is omitted). Validates the response through
 * `TasklistFromTemplateSchema`; rate-limit / request-id metadata live on
 * `raw` for the leaf command to surface in the envelope.
 *
 * Spec 0047 §5.2 / yaml :1290-1358.
 */
export async function createTasklistFromTemplate(
  client: HttpClient,
  opts: CreateTasklistFromTemplateOpts,
): Promise<CreateTasklistFromTemplateResult> {
  const raw = await client.request({
    method: 'POST',
    path: createTasklistFromTemplatePath(opts.templateId),
    body: opts.body,
    schema: TasklistFromTemplateSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { tasklist: raw.data, raw };
}
