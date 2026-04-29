import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { FindAvailableLabelsResponseSchema, type ProjectLabel } from './schemas/project-label.js';

/**
 * Wire wrappers for the `project-labels` resource group, R23 (spec 0035).
 *
 * Five endpoints:
 *   - `GET /project-labels/find-available`              — list available labels
 *   - `POST /project-labels/{labelId}`                  — rename / recolor / toggle private
 *   - `DELETE /project-labels/{labelId}`                — global hard-delete
 *   - `POST /project-labels/add-to-project/{projectId}` — attach (fetch-or-create)
 *   - `POST /project-labels/remove-from-project/{projectId}` — detach (id-mode)
 *
 * Verbs reconciled against OpenAPI per decisions 01-02 (spec 0035 §2.1):
 *   - rename: POST (not PATCH).
 *   - detach: POST (not DELETE).
 */

/* ---------------------------------------------------------------------------
 *  Path helpers — exposed so dry-run envelopes echo paths without re-running
 *  the network branch.
 * ------------------------------------------------------------------------- */

export const FIND_AVAILABLE_LABELS_PATH = '/project-labels/find-available';

/** Same path used by `POST` (rename) and `DELETE` (global delete). */
export const labelPath = (labelId: number): string => `/project-labels/${labelId}`;

export const attachLabelPath = (projectId: number): string =>
  `/project-labels/add-to-project/${projectId}`;

export const detachLabelPath = (projectId: number): string =>
  `/project-labels/remove-from-project/${projectId}`;

/* ---------------------------------------------------------------------------
 *  Shared opts shape — mirrors the convention in `src/api/reports.ts`.
 * ------------------------------------------------------------------------- */

export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  GET /project-labels/find-available
 * ------------------------------------------------------------------------- */

export type FindAvailableLabelsResult = {
  labels: ProjectLabel[];
  raw: ApiResponse<unknown>;
};

/**
 * `GET /project-labels/find-available` — returns the caller's available
 * project labels (their private + public from accessible projects).
 *
 * No query parameters. Spec 0035 §4.1.
 */
export async function findAvailableLabels(
  client: HttpClient,
  opts: FetchOpts = {},
): Promise<FindAvailableLabelsResult> {
  const raw = await client.request({
    method: 'GET',
    path: FIND_AVAILABLE_LABELS_PATH,
    schema: FindAvailableLabelsResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { labels: raw.data.label, raw };
}

/* ---------------------------------------------------------------------------
 *  POST /project-labels/{labelId} — edit (rename / recolor / toggle private)
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/project-labels/{labelId}` (yaml :888-897).
 * Every field optional server-side; CLI rejects empty edit at the command
 * layer (decision 04).
 */
export type EditProjectLabelBody = {
  name?: string;
  color?: string;
  is_private?: boolean;
};

/** CLI-side input to `buildEditProjectLabelBody`. Pure mapper, no I/O. */
export type EditProjectLabelInput = {
  name?: string;
  color?: string;
  isPrivate?: boolean;
};

export type EditProjectLabelOpts = FetchOpts & {
  body: EditProjectLabelBody;
};

export type EditProjectLabelResult = {
  raw: ApiResponse<unknown>;
};

/** Map CLI input → wire body. Pure. Omits keys the user didn't set. */
export function buildEditProjectLabelBody(input: EditProjectLabelInput): EditProjectLabelBody {
  const body: EditProjectLabelBody = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.color !== undefined) body.color = input.color;
  if (input.isPrivate !== undefined) body.is_private = input.isPrivate;
  return body;
}

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields. Mirrors the local schema in `src/api/reports.ts`.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

/**
 * `POST /project-labels/{labelId}` — rename / recolor / toggle is_private.
 *
 * Verb is POST, not PATCH (spec 0035 decision 01). Spec 0035 §4.2.
 */
export async function editProjectLabel(
  client: HttpClient,
  labelId: number,
  opts: EditProjectLabelOpts,
): Promise<EditProjectLabelResult> {
  const raw = await client.request({
    method: 'POST',
    path: labelPath(labelId),
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/* ---------------------------------------------------------------------------
 *  DELETE /project-labels/{labelId} — global hard-delete
 * ------------------------------------------------------------------------- */

export type DeleteProjectLabelOpts = FetchOpts;

export type DeleteProjectLabelResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `DELETE /project-labels/{labelId}` — global hard-delete (yaml :905).
 *
 * Empty body. The leaf command catches `FreeloApiError` and applies the
 * two-arm idempotency heuristic (404 → idempotent skip; otherwise re-throw).
 *
 * Spec 0035 §4.3.
 */
export async function deleteProjectLabel(
  client: HttpClient,
  labelId: number,
  opts: DeleteProjectLabelOpts = {},
): Promise<DeleteProjectLabelResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: labelPath(labelId),
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/* ---------------------------------------------------------------------------
 *  POST /project-labels/add-to-project/{projectId} — attach (data-mode)
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `add-to-project` (yaml :962-981) in
 * **data mode**. CLI does not surface id-mode (decision 07).
 *
 * `is_private` is required server-side in data mode (yaml :978).
 */
export type AttachProjectLabelBody = {
  name: string;
  is_private: boolean;
  color?: string;
};

export type AttachProjectLabelInput = {
  name: string;
  isPrivate: boolean;
  color?: string;
};

export type AttachProjectLabelOpts = FetchOpts & {
  body: AttachProjectLabelBody;
};

export type AttachProjectLabelResult = {
  raw: ApiResponse<unknown>;
};

export function buildAttachProjectLabelBody(
  input: AttachProjectLabelInput,
): AttachProjectLabelBody {
  const body: AttachProjectLabelBody = {
    name: input.name,
    is_private: input.isPrivate,
  };
  if (input.color !== undefined) body.color = input.color;
  return body;
}

/**
 * `POST /project-labels/add-to-project/{projectId}` — attach a label
 * (fetch-or-create on the server side). Spec 0035 §4.4.
 */
export async function attachLabelToProject(
  client: HttpClient,
  projectId: number,
  opts: AttachProjectLabelOpts,
): Promise<AttachProjectLabelResult> {
  const raw = await client.request({
    method: 'POST',
    path: attachLabelPath(projectId),
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/* ---------------------------------------------------------------------------
 *  POST /project-labels/remove-from-project/{projectId} — detach (id-mode)
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `remove-from-project` (yaml :1013-1030)
 * in **id mode**. CLI does not surface data-mode (out of scope v1 — see
 * spec 0035 §8 non-goals).
 */
export type DetachProjectLabelBody = {
  id: number;
};

export type DetachProjectLabelOpts = FetchOpts & {
  body: DetachProjectLabelBody;
};

export type DetachProjectLabelResult = {
  raw: ApiResponse<unknown>;
};

export function buildDetachProjectLabelBody(labelId: number): DetachProjectLabelBody {
  return { id: labelId };
}

/**
 * `POST /project-labels/remove-from-project/{projectId}` — detach a label
 * from the given project. Verb is POST, not DELETE (spec 0035 decision 02).
 * Spec 0035 §4.5.
 */
export async function detachLabelFromProject(
  client: HttpClient,
  projectId: number,
  opts: DetachProjectLabelOpts,
): Promise<DetachProjectLabelResult> {
  const raw = await client.request({
    method: 'POST',
    path: detachLabelPath(projectId),
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
