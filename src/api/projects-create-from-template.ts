import { type ApiResponse, type HttpClient } from './client.js';
import {
  ProjectFromTemplateSchema,
  type CreateProjectFromTemplateBody,
  type CreateProjectFromTemplateInput,
  type ProjectFromTemplate,
} from './schemas/project.js';

/**
 * Map the CLI input shape (camel-case, already-normalized currency/layout)
 * to the Freelo wire body for `POST /project/create-from-template/{template_id}`
 * (OpenAPI :785-814).
 *
 * Pure function — no I/O, no global state. Easy to unit-test without MSW.
 *
 * Mappings:
 *   - `name`: passthrough.
 *   - `ownerId` → `project_owner_id` (omitted when undefined).
 *   - `currency` → `currency_iso` (already uppercased by the CLI flag parser).
 *   - `dateStart` → `preset_date_from` (already validated as `YYYY-MM-DD`).
 *   - `layout` → nested `general_settings: { layout }`. The `general_settings`
 *     object is omitted entirely when `layout` is unset.
 *   - `workers` → `users_ids` (only when non-empty; an empty array is treated
 *     as "no workers specified" and the field is omitted).
 *
 * Fields are emitted only when set — mirrors the R29 `buildCreateProjectBody`
 * convention so dry-run output stays minimal.
 *
 * Spec 0044 §5.
 */
export function buildCreateProjectFromTemplateBody(
  input: CreateProjectFromTemplateInput,
): CreateProjectFromTemplateBody {
  const body: CreateProjectFromTemplateBody = { name: input.name };
  if (input.ownerId !== undefined) {
    body.project_owner_id = input.ownerId;
  }
  if (input.currency !== undefined) {
    body.currency_iso = input.currency;
  }
  if (input.dateStart !== undefined) {
    body.preset_date_from = input.dateStart;
  }
  if (input.layout !== undefined) {
    body.general_settings = { layout: input.layout };
  }
  if (input.workers !== undefined && input.workers.length > 0) {
    body.users_ids = [...input.workers];
  }
  return body;
}

/**
 * Build the wire path for `POST /project/create-from-template/{template_id}`.
 * Centralized so `--dry-run` can echo the same string without rebuilding it.
 *
 * Caller is responsible for validating `templateId` is a positive integer
 * (the CLI does this via `parseTemplateIdArg`). No URL-encoding needed —
 * integer.
 */
export function createProjectFromTemplatePath(templateId: number): string {
  return `/project/create-from-template/${templateId}`;
}

export type CreateProjectFromTemplateOpts = {
  templateId: number;
  body: CreateProjectFromTemplateBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type CreateProjectFromTemplateResult = {
  project: ProjectFromTemplate;
  raw: ApiResponse<ProjectFromTemplate>;
};

/**
 * `POST /project/create-from-template/{template_id}` — clones a project
 * template (state_id=3) into a new active project. Validates the response
 * through `ProjectFromTemplateSchema`; rate-limit / request-id metadata live
 * on `raw` for the leaf command to surface in the envelope.
 *
 * Spec 0044 §5 / OpenAPI :759-830.
 */
export async function createProjectFromTemplate(
  client: HttpClient,
  opts: CreateProjectFromTemplateOpts,
): Promise<CreateProjectFromTemplateResult> {
  const raw = await client.request({
    method: 'POST',
    path: createProjectFromTemplatePath(opts.templateId),
    body: opts.body,
    schema: ProjectFromTemplateSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { project: raw.data, raw };
}
