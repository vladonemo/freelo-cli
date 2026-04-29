import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import { WorkReportFullSchema, type WorkReportFull } from './schemas/report.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

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
