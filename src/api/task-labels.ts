import { type ApiResponse, type HttpClient } from './client.js';
import {
  FindAvailableTaskLabelsResponseSchema,
  SuccessResponseSchema,
  TaskLabelColorsResponseSchema,
  type TaskLabel,
  type TaskLabelColor,
} from './schemas/task-label.js';
import { buildQuery } from '../lib/query.js';

/**
 * Wire wrappers for the `task-labels` resource group, R24 (spec 0036),
 * M04 (spec 0062), M05 (spec 0067) and M06 (spec 0068).
 *
 * Six endpoints:
 *   - `POST /task-labels`                                — bulk-create
 *   - `POST /task-labels/add-to-task/{task_id}`          — attach
 *   - `POST /task-labels/remove-from-task/{task_id}`     — detach
 *   - `GET  /task-labels/find-available`                 — list (M04)
 *   - `GET  /task-label-colors`                          — palette (M05)
 *   - `POST /task-labels/merge`                          — merge (M06)
 *
 * Verbs reconciled against OpenAPI (spec 0036 decision 01) — detach is POST,
 * not DELETE despite roadmap copy. OpenAPI is authoritative.
 *
 * The API is bulk-by-design: every endpoint bar `merge` takes
 * `{ labels: [...] }` (merge takes `{ from_uuids, to_uuid }`). Unlike
 * R23 project-labels, there is **no per-name fan-out** — the CLI sends one
 * POST per invocation (spec 0036 decision 05).
 */

/* ---------------------------------------------------------------------------
 *  Path helpers — exported so dry-run envelopes echo paths without re-running
 *  the network branch.
 * ------------------------------------------------------------------------- */

export const TASK_LABELS_PATH = '/task-labels';

export const addTaskLabelsPath = (taskId: number): string => `/task-labels/add-to-task/${taskId}`;

export const removeTaskLabelsPath = (taskId: number): string =>
  `/task-labels/remove-from-task/${taskId}`;

export const FIND_AVAILABLE_TASK_LABELS_PATH = '/task-labels/find-available';

/**
 * `GET /task-label-colors` (M05, spec 0067). Note the singular `task-label-`
 * prefix and the absence of a `/task-labels/` parent — this is a top-level
 * path in the contract (yaml :2878), not a child of the `task-labels`
 * resource. Takes no parameters of any kind.
 */
export const TASK_LABEL_COLORS_PATH = '/task-label-colors';

/**
 * Compose the find-available path, appending `?project_id=` only when a
 * project scope was requested. Omitted → bare path, no query string at all
 * (matching the convention in `src/api/tasks.ts` / `src/api/reports.ts`).
 *
 * Exported so tests can assert the composed path without a live request.
 */
export const findAvailableTaskLabelsPath = (projectId?: number): string => {
  const qs = buildQuery({ project_id: projectId });
  return qs.length > 0
    ? `${FIND_AVAILABLE_TASK_LABELS_PATH}?${qs}`
    : FIND_AVAILABLE_TASK_LABELS_PATH;
};

/* ---------------------------------------------------------------------------
 *  Shared opts shape — mirrors the convention in `src/api/project-labels.ts`.
 * ------------------------------------------------------------------------- */

export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  Wire body shapes
 *
 *  POST /task-labels (yaml :2464-2479)
 *  ---
 *  Each entry is `{ name?, color? }` per the schema (both optional in the
 *  spec, though `name` is in practice required). The CLI command layer
 *  enforces non-empty names.
 * ------------------------------------------------------------------------- */

export type CreateTaskLabelEntry = {
  name: string;
  color?: string;
};

export type CreateTaskLabelsBody = {
  labels: CreateTaskLabelEntry[];
};

/**
 * Pure builder: input is the CLI's resolved name list and an optional
 * shared color. Each name becomes one entry; the color (if any) is applied
 * to every entry per spec 0036 decision 04.
 */
export function buildCreateTaskLabelsBody(input: {
  names: readonly string[];
  color?: string;
}): CreateTaskLabelsBody {
  const entries: CreateTaskLabelEntry[] = input.names.map((name) => {
    const entry: CreateTaskLabelEntry = { name };
    if (input.color !== undefined) entry.color = input.color;
    return entry;
  });
  return { labels: entries };
}

/* ---------------------------------------------------------------------------
 *  TaskLabelAddInput entry — `oneOf` UUID-mode | name-mode (yaml :5139-5169)
 * ------------------------------------------------------------------------- */

export type AddTaskLabelEntry = { uuid: string } | { name: string; color?: string; uuid?: string };

export type AddTaskLabelsBody = {
  labels: AddTaskLabelEntry[];
};

/**
 * Pure builder. Input separates uuid-only entries from name-mode entries.
 * The shared `color` (if any) is applied to every name-mode entry only —
 * uuid-mode entries do not carry color (server uses the existing label's
 * color).
 */
export function buildAddTaskLabelsBody(input: {
  uuids: readonly string[];
  names: readonly string[];
  color?: string;
}): AddTaskLabelsBody {
  const entries: AddTaskLabelEntry[] = [];
  for (const uuid of input.uuids) entries.push({ uuid });
  for (const name of input.names) {
    const entry: { name: string; color?: string } = { name };
    if (input.color !== undefined) entry.color = input.color;
    entries.push(entry);
  }
  return { labels: entries };
}

/* ---------------------------------------------------------------------------
 *  TaskLabelRemoveInput entry — `oneOf` UUID | name-only | name+color
 *  (yaml :5171-5204)
 * ------------------------------------------------------------------------- */

export type RemoveTaskLabelEntry =
  | { uuid: string }
  | { name: string }
  | { name: string; color: string };

export type RemoveTaskLabelsBody = {
  labels: RemoveTaskLabelEntry[];
};

/**
 * Pure builder. When `color` is provided, every name-mode entry upgrades
 * from name-only mode → name+color mode. uuid-mode entries are unchanged.
 */
export function buildRemoveTaskLabelsBody(input: {
  uuids: readonly string[];
  names: readonly string[];
  color?: string;
}): RemoveTaskLabelsBody {
  const entries: RemoveTaskLabelEntry[] = [];
  for (const uuid of input.uuids) entries.push({ uuid });
  for (const name of input.names) {
    if (input.color !== undefined) {
      entries.push({ name, color: input.color });
    } else {
      entries.push({ name });
    }
  }
  return { labels: entries };
}

/* ---------------------------------------------------------------------------
 *  Wire calls
 * ------------------------------------------------------------------------- */

export type CreateTaskLabelsOpts = FetchOpts & {
  body: CreateTaskLabelsBody;
};

export type CreateTaskLabelsResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /task-labels` — bulk-create label definitions in the caller's
 * workspace. Server-side fetch-or-create on `name` (case-sensitive). Spec
 * 0036 §4.1.
 */
export async function createTaskLabels(
  client: HttpClient,
  opts: CreateTaskLabelsOpts,
): Promise<CreateTaskLabelsResult> {
  const raw = await client.request({
    method: 'POST',
    path: TASK_LABELS_PATH,
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

export type AddTaskLabelsOpts = FetchOpts & {
  body: AddTaskLabelsBody;
};

export type AddTaskLabelsResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /task-labels/add-to-task/{task_id}` — attach labels to a task.
 * Mixed UUID + name-mode entries allowed (the OpenAPI `oneOf` is per-entry).
 * Spec 0036 §4.2.
 */
export async function addTaskLabelsToTask(
  client: HttpClient,
  taskId: number,
  opts: AddTaskLabelsOpts,
): Promise<AddTaskLabelsResult> {
  const raw = await client.request({
    method: 'POST',
    path: addTaskLabelsPath(taskId),
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

export type RemoveTaskLabelsOpts = FetchOpts & {
  body: RemoveTaskLabelsBody;
};

export type RemoveTaskLabelsResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /task-labels/remove-from-task/{task_id}` — detach labels from a
 * task. Verb is POST, not DELETE (spec 0036 decision 01).
 *
 * Server is already idempotent (200 even when the label isn't on the task).
 * No two-arm 404 heuristic. Spec 0036 §4.3.
 */
export async function removeTaskLabelsFromTask(
  client: HttpClient,
  taskId: number,
  opts: RemoveTaskLabelsOpts,
): Promise<RemoveTaskLabelsResult> {
  const raw = await client.request({
    method: 'POST',
    path: removeTaskLabelsPath(taskId),
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

/* ---------------------------------------------------------------------------
 *  GET /task-labels/find-available  (M04, spec 0062)
 * ------------------------------------------------------------------------- */

export type FindAvailableTaskLabelsOpts = FetchOpts & {
  /** Restrict to labels used in this project. Omitted → all usable labels. */
  projectId?: number;
};

export type FindAvailableTaskLabelsResult = {
  labels: TaskLabel[];
  raw: ApiResponse<unknown>;
};

/**
 * `GET /task-labels/find-available` — every task label usable by the caller,
 * sorted by `name` ascending (server-side), optionally scoped to one project.
 *
 * **Empty is a success, not an error.** The server returns HTTP 200 with
 * `{ "labels": [] }` when `projectId` names a project the caller can't reach
 * *and* when the caller has no accessible projects at all. It does not
 * distinguish the two, and neither does this wrapper — no synthesised 404, no
 * throw. Spec 0062 §5 / decision 04.
 *
 * Not to be confused with `findAvailableLabels` in `src/api/project-labels.ts`
 * (`GET /project-labels/find-available`) — separate endpoint, id-keyed items,
 * accepts no query parameters. Spec 0062 §3.1.
 */
export async function findAvailableTaskLabels(
  client: HttpClient,
  opts: FindAvailableTaskLabelsOpts = {},
): Promise<FindAvailableTaskLabelsResult> {
  const raw = await client.request({
    method: 'GET',
    path: findAvailableTaskLabelsPath(opts.projectId),
    schema: FindAvailableTaskLabelsResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { labels: raw.data.labels, raw };
}

/* ---------------------------------------------------------------------------
 *  GET /task-label-colors  (M05, spec 0067)
 * ------------------------------------------------------------------------- */

export type GetTaskLabelColorsResult = {
  colors: TaskLabelColor[];
  raw: ApiResponse<unknown>;
};

/**
 * `GET /task-label-colors` — the palette Freelo accepts for task-label colors.
 *
 * Read-only, unparameterised, unpaginated. The response's `display_name` is
 * documented as display-only and **not accepted as input** (yaml :5968); the
 * only value that goes back over the wire is `color`. That contract fact is
 * why the CLI's `--palette` name table stays a local constant rather than
 * becoming a live fetch — spec 0067 §6.
 *
 * An empty `colors: []` is a valid body, not an error. A body missing the
 * `colors` key fails schema validation loudly (exit 4).
 */
export async function getTaskLabelColors(
  client: HttpClient,
  opts: FetchOpts = {},
): Promise<GetTaskLabelColorsResult> {
  const raw = await client.request({
    method: 'GET',
    path: TASK_LABEL_COLORS_PATH,
    schema: TaskLabelColorsResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { colors: raw.data.colors, raw };
}

/* ---------------------------------------------------------------------------
 *  POST /task-labels/merge  (M06, spec 0068)
 * ------------------------------------------------------------------------- */

/**
 * `POST /task-labels/merge` (yaml :2936). A sibling of `/task-labels/*` in
 * naming only — it takes no path parameter and no `labels` array, unlike every
 * other endpoint in this group.
 */
export const TASK_LABELS_MERGE_PATH = '/task-labels/merge';

/**
 * Wire body of `POST /task-labels/merge` (yaml :2954-2973). Both keys are
 * required by the contract; neither is nullable and neither has a default.
 *
 * Note what is *not* here: no `name`, no `color`. The target label's name and
 * colour are taken from the existing `to_uuid` label and cannot be set through
 * this call (yaml :2951).
 */
export type MergeTaskLabelsBody = {
  from_uuids: string[];
  to_uuid: string;
};

/**
 * Build the merge body. Pure — exported so the `--dry-run` path can echo the
 * exact object that would have gone over the wire without touching the network
 * branch (same pattern as `buildAddTaskLabelsBody`).
 *
 * De-duplication and the self-merge check happen in the command layer, before
 * this is called; this function does not validate.
 */
export function buildMergeTaskLabelsBody(input: {
  fromUuids: readonly string[];
  toUuid: string;
}): MergeTaskLabelsBody {
  return { from_uuids: [...input.fromUuids], to_uuid: input.toUuid };
}

export type MergeTaskLabelsOpts = FetchOpts & {
  body: MergeTaskLabelsBody;
};

export type MergeTaskLabelsResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Merge one or more source labels into a target label server-side.
 *
 * **The 200 body says nothing about what happened.** It is the generic
 * `SuccessResponse` — `{ "result": "success" }` — with no task count, no list
 * of affected tasks, and no indication of how many tasks were skipped because
 * the caller is not a commander in their project (yaml :2948). Callers must
 * not infer completeness from a 200; see spec 0068 §D1 for why the envelope
 * refuses to fabricate one.
 *
 * A `404` means *either* a label does not exist *or* the caller does not own
 * it — the contract collapses the two deliberately (yaml :2947). It is never
 * absorbed into an idempotent success here or in the command layer.
 */
export async function mergeTaskLabels(
  client: HttpClient,
  opts: MergeTaskLabelsOpts,
): Promise<MergeTaskLabelsResult> {
  const raw = await client.request({
    method: 'POST',
    path: TASK_LABELS_MERGE_PATH,
    body: opts.body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
