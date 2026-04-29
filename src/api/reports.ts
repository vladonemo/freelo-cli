import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { WorkReportFullSchema, type WorkReportFull } from './schemas/report.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

/* ---------------------------------------------------------------------------
 *  Path helpers
 *
 *  Exposed so dry-run envelopes echo paths without re-running the network
 *  branch. Mirrors `START_TIMER_PATH` etc. in `src/api/time.ts`.
 * ------------------------------------------------------------------------- */

/** `POST /task/{taskId}/work-reports` — log a finalized work report. */
export const createReportPath = (taskId: number): string => `/task/${taskId}/work-reports`;

/** `POST` (edit) and `DELETE` both use this path. */
export const reportPath = (id: number): string => `/work-reports/${id}`;

/**
 * Wire wrappers for the `reports` (work-reports) resource group, R21
 * (spec 0033).
 *
 * Single endpoint in v1: `GET /work-reports` — paginated list of every
 * finalized work report the caller can see, with filters by project,
 * worker, task, and a `date_reported` window. Mirrors the structure of
 * `getAllComments` in `src/api/comments.ts` byte-for-byte.
 *
 * The roadmap line names a second endpoint `GET /task/{task_id}/work-reports`
 * but that path is not in `docs/api/freelo-api.yaml` (only the POST
 * counterpart, used by R22). Decision 1 narrows R21 to the documented
 * global endpoint with `--task` mapped to `tasks_ids[]`. See
 * `docs/decisions/2026-04-28-2111-r21-reports-list-1-scope-narrow.md`.
 */

/** Two-field opts shared by R21's GET wrapper. Mirrors `FetchOpts` elsewhere. */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * Filter map for `GET /work-reports`. Each field maps 1-1 to a Freelo wire
 * parameter (OpenAPI `:2967-3025`):
 *
 *   - `tasks` → `tasks_ids[]`
 *   - `projects` → `projects_ids[]`
 *   - `workers` → `users_ids[]`
 *   - `from` → `date_reported_range[date_from]`
 *   - `to` → `date_reported_range[date_to]`
 *
 * Date strings are pre-validated `YYYY-MM-DD` at the leaf-command layer.
 */
export type WorkReportsFilters = {
  tasks?: readonly number[];
  projects?: readonly number[];
  workers?: readonly number[];
  from?: string;
  to?: string;
};

export type WorkReportsOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: WorkReportsFilters;
};

export type ReportsListResult = {
  page: NormalizedPage<WorkReportFull>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /work-reports?<query>` — paginated; inner key `reports`.
 *
 * Filter encoding via `buildQuery`:
 *   - Array params (`tasks_ids[]`, `projects_ids[]`, `users_ids[]`) emit one
 *     `key[]=value` pair per element — `URLSearchParams.append` percent-
 *     encodes the brackets once.
 *   - Date-range bracket-in-key params (`date_reported_range[date_from]`)
 *     percent-encode identically — the inner `[`/`]` are URL-encoded the same
 *     way as the trailing `[]` on array keys.
 *
 * Spec 0033 §4.2.
 */
export async function getWorkReports(
  client: HttpClient,
  opts: WorkReportsOpts,
): Promise<ReportsListResult> {
  const { filters } = opts;
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = {
    p: opts.page,
  };
  if (filters.tasks !== undefined && filters.tasks.length > 0) {
    params['tasks_ids[]'] = filters.tasks;
  }
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.workers !== undefined && filters.workers.length > 0) {
    params['users_ids[]'] = filters.workers;
  }
  if (filters.from !== undefined) {
    params['date_reported_range[date_from]'] = filters.from;
  }
  if (filters.to !== undefined) {
    params['date_reported_range[date_to]'] = filters.to;
  }

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `/work-reports?${qs}` : '/work-reports';
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'reports', WorkReportFullSchema);
  return { page, raw };
}

/* ---------------------------------------------------------------------------
 *  R22 — write wrappers (spec 0034)
 *
 *  Three endpoints:
 *    - `POST /task/{taskId}/work-reports` — log a new work report.
 *    - `POST /work-reports/{id}`          — edit an existing work report.
 *    - `DELETE /work-reports/{id}`        — delete a work report.
 *
 *  Mirrors the `time.ts` write-wrapper shape: a typed body, a typed input,
 *  a `buildXBody` pure mapper, and the wire-call function.
 *
 *  Note: the verb on edit is **POST**, not PATCH — see spec 0034 decision 01
 *  (and prior precedent: R18 comments-edit, R20 time-edit).
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/task/{taskId}/work-reports`
 * (yaml :3066-3086). `minutes` is the only required field; CLI does not
 * surface `worker_id` or `cost` in v1 (spec 0034 §4.1, decision 03).
 */
export type CreateReportBody = {
  minutes: number;
  date_reported?: string;
  note?: string;
};

/** CLI-side input to `buildCreateReportBody`. Pure mapper, no I/O. */
export type CreateReportInput = {
  minutes: number;
  /** Pre-validated `YYYY-MM-DD`. */
  dateReported?: string;
  note?: string;
};

export type CreateReportOpts = FetchOpts & {
  body: CreateReportBody;
};

export type CreateReportResult = {
  report: WorkReportFull;
  raw: ApiResponse<WorkReportFull>;
};

/** Map CLI input → wire body. Pure. Omits keys the user didn't set. */
export function buildCreateReportBody(input: CreateReportInput): CreateReportBody {
  const body: CreateReportBody = { minutes: input.minutes };
  if (input.dateReported !== undefined) body.date_reported = input.dateReported;
  if (input.note !== undefined) body.note = input.note;
  return body;
}

/**
 * `POST /task/{taskId}/work-reports` — log a finalized work report.
 *
 * Returns the parsed `WorkReportFull`. Wire-side errors (400 / 401 / etc.)
 * surface as `FreeloApiError`; the leaf command's catch arm decides
 * whether to rewrite hints.
 *
 * Spec 0034 §4.1.
 */
export async function createReport(
  client: HttpClient,
  taskId: number,
  opts: CreateReportOpts,
): Promise<CreateReportResult> {
  const raw = await client.request({
    method: 'POST',
    path: createReportPath(taskId),
    body: opts.body,
    schema: WorkReportFullSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { report: raw.data, raw };
}

/**
 * Wire-shape of the POST body for `/work-reports/{id}` (yaml :3119-3137).
 * Every field optional. CLI in v1 omits `task_id` (re-parent) and `cost`
 * — out of scope per spec 0034 §3.3.
 */
export type EditReportBody = {
  minutes?: number;
  date_reported?: string;
  note?: string;
};

export type EditReportInput = {
  minutes?: number;
  /** Pre-validated `YYYY-MM-DD`. */
  dateReported?: string;
  note?: string;
};

export type EditReportOpts = FetchOpts & {
  body: EditReportBody;
};

export type EditReportResult = {
  report: WorkReportFull;
  raw: ApiResponse<WorkReportFull>;
};

/** Map CLI input → wire body. Pure. Omits keys the user didn't set. */
export function buildEditReportBody(input: EditReportInput): EditReportBody {
  const body: EditReportBody = {};
  if (input.minutes !== undefined) body.minutes = input.minutes;
  if (input.dateReported !== undefined) body.date_reported = input.dateReported;
  if (input.note !== undefined) body.note = input.note;
  return body;
}

/**
 * `POST /work-reports/{id}` — edit an existing work report. Verb is POST,
 * not PATCH (spec 0034 decision 01). Spec 0034 §4.2.
 */
export async function editReport(
  client: HttpClient,
  id: number,
  opts: EditReportOpts,
): Promise<EditReportResult> {
  const raw = await client.request({
    method: 'POST',
    path: reportPath(id),
    body: opts.body,
    schema: WorkReportFullSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { report: raw.data, raw };
}

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()`. Mirrors the local schema in
 * `src/api/tasks-delete.ts`.
 */
const DeleteSuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type DeleteReportOpts = FetchOpts;

export type DeleteReportResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `DELETE /work-reports/{id}` — delete a work report. Empty body. The
 * leaf command (`src/commands/reports/delete.ts`) catches `FreeloApiError`
 * and applies the four-arm idempotency heuristic (spec 0034 §4.3,
 * decision 02). This wrapper does NOT special-case any status.
 *
 * Spec 0034 §4.3.
 */
export async function deleteReport(
  client: HttpClient,
  id: number,
  opts: DeleteReportOpts = {},
): Promise<DeleteReportResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: reportPath(id),
    schema: DeleteSuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
