import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskFullSchema,
  TaskSummarySchema,
  TaskDetailSchema,
  TaskCommentSchema,
  SubtaskSchema,
  type TaskFull,
  type TaskSummary,
  type TaskDetail,
  type TaskComment,
  type Subtask,
} from './schemas/task.js';
import { type NormalizedPage, normalizePaginated, synthesizeUnpaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

/**
 * Two-field opts shared by R07's GET wrappers. Mirrors the `FetchOpts` type
 * declared in `src/api/tasklists.ts` (R06).
 */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type TasksListResult<T> = {
  page: NormalizedPage<T>;
  raw: ApiResponse<unknown>;
};

/**
 * Filter map for `GET /all-tasks`. Each field maps 1-1 to a Freelo wire
 * parameter (see spec 0017 §3 / OpenAPI :1437-1525). Boolean filters default
 * to `false` and are omitted from the URL when unset.
 */
export type AllTasksFilters = {
  projects?: readonly number[];
  tasklists?: readonly number[];
  worker?: number;
  state?: number;
  labels?: readonly string[];
  withoutLabel?: string;
  dueFrom?: string;
  dueTo?: string;
  noDue?: boolean;
  finishedOverdue?: boolean;
  finishedFrom?: string;
  finishedTo?: string;
  search?: string;
  orderBy?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

export type AllTasksOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllTasksFilters;
};

/**
 * `GET /all-tasks?<query>` — paginated; inner key `tasks`. Filters compose
 * via `buildQuery` with the bracketed-array convention Freelo expects (e.g.
 * `projects_ids[]=42&projects_ids[]=43`). Spec 0017 §2.5 / §4.3.
 */
export async function getAllTasks(
  client: HttpClient,
  opts: AllTasksOpts,
): Promise<TasksListResult<TaskFull>> {
  const { filters } = opts;
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = {
    p: opts.page,
  };
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.tasklists !== undefined && filters.tasklists.length > 0) {
    params['tasklists_ids[]'] = filters.tasklists;
  }
  if (filters.worker !== undefined) params['worker_id'] = filters.worker;
  if (filters.state !== undefined) params['state_id'] = filters.state;
  if (filters.labels !== undefined && filters.labels.length > 0) {
    params['with_labels[]'] = filters.labels;
  }
  if (filters.withoutLabel !== undefined) params['without_label'] = filters.withoutLabel;
  if (filters.dueFrom !== undefined) params['due_date_range[date_from]'] = filters.dueFrom;
  if (filters.dueTo !== undefined) params['due_date_range[date_to]'] = filters.dueTo;
  if (filters.noDue === true) params['no_due_date'] = true;
  if (filters.finishedOverdue === true) params['finished_overdue'] = true;
  if (filters.finishedFrom !== undefined) {
    params['finished_date_range[date_from]'] = filters.finishedFrom;
  }
  if (filters.finishedTo !== undefined) {
    params['finished_date_range[date_to]'] = filters.finishedTo;
  }
  if (filters.search !== undefined) params['search_query'] = filters.search;
  if (filters.orderBy !== undefined) params['order_by'] = filters.orderBy;
  if (filters.order !== undefined) params['order'] = filters.order;

  const qs = buildQuery(params);
  const raw = await client.request({
    method: 'GET',
    path: `/all-tasks?${qs}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'tasks', TaskFullSchema);
  return { page, raw };
}

/**
 * Ordering the CLI asks for on `/project/{p}/tasklist/{t}/tasks` when the
 * user expresses no preference. `priority` is the tasklist's manual board
 * order on this endpoint; see `getTasklistActiveTasks` and spec 0060.
 */
export const TASKLIST_TASKS_DEFAULT_ORDER_BY = 'priority';
export const TASKLIST_TASKS_DEFAULT_ORDER = 'asc';

export type TasklistTasksOpts = FetchOpts & {
  projectId: number;
  tasklistId: number;
  orderBy?: 'priority' | 'name' | 'date_add' | 'date_edited_at';
  order?: 'asc' | 'desc';
};

/**
 * `GET /project/{p}/tasklist/{t}/tasks?<query>` — bare `TaskSummary[]`,
 * NOT paginated. Synthesizes a single-page wrapper. Only `order_by` /
 * `order` are documented filter passthroughs; the dispatcher in the leaf
 * command guarantees no other filters are routed here. Spec 0017 §2.2.
 *
 * Ordering (spec 0060, issue #108): when the caller supplies **neither**
 * `orderBy` nor `order`, the request explicitly asks for
 * `order_by=priority&order=asc` rather than omitting both parameters and
 * inheriting an unstated server default. On this endpoint `priority` is the
 * tasklist's manual / drag-and-drop board order — not the L/M/H
 * `priority_enum` that `POST /task/{id}` accepts. That was verified live
 * against a dedicated test account (2026-08-24): dragging a task to the top
 * of the board in the web UI moved it to index 0 in the response, for both
 * the bare request and `order_by=priority`, while `order_by=date_add`
 * returned a distinct order.
 *
 * A caller-supplied value always wins. Supplying only one of the two flags
 * suppresses the default for both, so a partially-specified request stays
 * byte-identical on the wire to what this function sent before spec 0060.
 */
export async function getTasklistActiveTasks(
  client: HttpClient,
  opts: TasklistTasksOpts,
): Promise<TasksListResult<TaskSummary>> {
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = {};
  if (opts.orderBy === undefined && opts.order === undefined) {
    params['order_by'] = TASKLIST_TASKS_DEFAULT_ORDER_BY;
    params['order'] = TASKLIST_TASKS_DEFAULT_ORDER;
  } else {
    if (opts.orderBy !== undefined) params['order_by'] = opts.orderBy;
    if (opts.order !== undefined) params['order'] = opts.order;
  }
  // Every branch above writes at least one parameter, so `qs` is never empty.
  const qs = buildQuery(params);
  const path = `/project/${opts.projectId}/tasklist/${opts.tasklistId}/tasks?${qs}`;
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.array(TaskSummarySchema),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = synthesizeUnpaginated(raw.data);
  return { page, raw };
}

/* ---------------------------------------------------------------------------
 *  R08 — `freelo tasks show <id>` (spec 0018)
 * ------------------------------------------------------------------------- */

/**
 * `GET /task/{id}` — returns the rich `TaskDetail` shape. Carries the
 * `multi_project_task` block that R08's `--with projects` projects into
 * the envelope (decision 1, no separate HTTP call).
 *
 * OpenAPI :1662-1689. Spec 0018 §4.5.
 */
export async function getTaskDetail(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TaskDetail>> {
  return client.request({
    method: 'GET',
    path: `/task/${taskId}`,
    schema: TaskDetailSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
}

/**
 * `GET /task/{id}/description` — returns a single `Comment` (id, content,
 * date_add, files[]). Empty descriptions still return 200 with empty/null
 * fields per OpenAPI :2014; the schema's `id`/`content` are nullable to
 * tolerate that.
 *
 * OpenAPI :2002-2025. Spec 0018 §4.5.
 */
export async function getTaskDescription(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts,
): Promise<ApiResponse<TaskComment>> {
  return client.request({
    method: 'GET',
    path: `/task/${taskId}/description`,
    schema: TaskCommentSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
}

/**
 * `GET /task/{id}/subtasks?p=N` — paginated; inner key `subtasks`, items are
 * `Subtask`. Reuses `normalizePaginated` so the command can drive
 * `fetchAllPages` with the standard contract (mirrors R04 `getProjectWorkers`).
 *
 * OpenAPI :2380-2415. Spec 0018 §4.5.
 */
export async function getTaskSubtasks(
  client: HttpClient,
  taskId: number,
  opts: FetchOpts & { page: number },
): Promise<{ page: NormalizedPage<Subtask>; raw: ApiResponse<unknown> }> {
  const raw = await client.request({
    method: 'GET',
    path: `/task/${taskId}/subtasks?p=${opts.page}`,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'subtasks', SubtaskSchema);
  return { page, raw };
}
