import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskDetailSchema,
  type EditTaskBody,
  type EditTaskInput,
  type TaskDetail,
} from './schemas/task.js';

/**
 * Map the CLI input shape (`--priority high`, `--due 2026-05-01`,
 * `--clear-priority`) to the Freelo wire shape `EditTaskBody` (subset of
 * OpenAPI :1717-1755).
 *
 * Pure function — no I/O, no global state. Easy to unit-test.
 *
 * Mappings (mirror R09's `buildCreateTaskBody`):
 *   - `priority`: low → l, normal → m, high → h.
 *   - `clearPriority`: emits `priority_enum: null` (explicit clear,
 *     OpenAPI :1739 — `priority_enum` is nullable). Mutex with `priority`
 *     enforced at the command layer; if both arrive, `priority` wins (same
 *     semantics as Object.assign-with-precedence — but the command rejects
 *     this earlier with `ValidationError`).
 *   - `due`: `YYYY-MM-DD` → `YYYY-MM-DDT00:00:00Z` (matches R09 decision 1).
 *
 * Fields are emitted only when set (matches R07's filter-omit convention).
 * An empty input (all undefined) returns `{}` — callers must check for that
 * and skip the POST entirely (spec 0020 decision 15).
 *
 * Spec 0020 §5.
 */
export function buildEditTaskBody(input: EditTaskInput): EditTaskBody {
  const body: EditTaskBody = {};
  if (input.name !== undefined) body.name = input.name;
  if (input.due !== undefined) body.due_date = `${input.due}T00:00:00Z`;
  if (input.worker !== undefined) body.worker = input.worker;
  if (input.priority !== undefined) {
    body.priority_enum = input.priority === 'low' ? 'l' : input.priority === 'normal' ? 'm' : 'h';
  } else if (input.clearPriority === true) {
    body.priority_enum = null;
  }
  return body;
}

/** Whether `buildEditTaskBody`'s output is the empty object (no edit needed). */
export function isEmptyEditBody(body: EditTaskBody): boolean {
  return Object.keys(body).length === 0;
}

/* ---------------------------------------------------------------------------
 *  Path helpers (used by `--dry-run` and the live wrappers)
 * ------------------------------------------------------------------------- */

export function editTaskPath(taskId: number): string {
  return `/task/${taskId}`;
}

export function addLabelsPath(taskId: number): string {
  return `/task-labels/add-to-task/${taskId}`;
}

export function removeLabelsPath(taskId: number): string {
  return `/task-labels/remove-from-task/${taskId}`;
}

/* ---------------------------------------------------------------------------
 *  Wire wrappers
 * ------------------------------------------------------------------------- */

export type EditTaskOpts = {
  taskId: number;
  body: EditTaskBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type EditTaskResult = {
  task: TaskDetail;
  raw: ApiResponse<TaskDetail>;
};

/**
 * `POST /task/{task_id}` — partial edit. Validates the response through
 * `TaskDetailSchema`. The rate-limit / request-id metadata live on `raw` for
 * the leaf command to surface in the envelope.
 *
 * Spec 0020 §5 / OpenAPI :1690-1762.
 */
export async function editTask(client: HttpClient, opts: EditTaskOpts): Promise<EditTaskResult> {
  const raw = await client.request({
    method: 'POST',
    path: editTaskPath(opts.taskId),
    body: opts.body,
    schema: TaskDetailSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { task: raw.data, raw };
}

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type LabelsDiffResult = {
  /**
   * Names actually sent on the wire (for envelope `applied_changes.*` echoing).
   * Empty when the call was skipped (no names supplied) — see decision: we
   * never send a `{ labels: [] }` body; the API short-circuits, but the
   * round-trip still costs a request.
   */
  names: string[];
  /**
   * `null` when the call was skipped. Otherwise the raw response (carries
   * rate-limit headers).
   */
  raw: ApiResponse<unknown> | null;
};

export type LabelsDiffOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * `POST /task-labels/add-to-task/{task_id}` — name-mode add.
 *
 * Each name is sent as `{ name }` (server defaults color to `#77787a`).
 * Names are **case-sensitive** server-side (OpenAPI :2501). When `names` is
 * empty (after dedupe at the command layer), the call is **skipped** — we
 * return `{ names: [], raw: null }` without round-tripping. Spec 0020 §3.5.
 *
 * Names are NOT trimmed by this layer — preserving leading/trailing
 * whitespace is intentional (R09 convention; Freelo treats `"foo"` and
 * `"foo "` as distinct).
 */
export async function addTaskLabels(
  client: HttpClient,
  taskId: number,
  names: readonly string[],
  opts: LabelsDiffOpts = {},
): Promise<LabelsDiffResult> {
  if (names.length === 0) return { names: [], raw: null };
  const body = { labels: names.map((name) => ({ name })) };
  const raw = await client.request({
    method: 'POST',
    path: addLabelsPath(taskId),
    body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { names: [...names], raw };
}

/**
 * `POST /task-labels/remove-from-task/{task_id}` — name-mode remove.
 *
 * **Aggressive name semantics:** removes every label matching the name
 * regardless of color (OpenAPI :2548). The CLI surfaces this in `--help`.
 * Same skip-when-empty convention as `addTaskLabels`. Spec 0020 §3.5.
 */
export async function removeTaskLabels(
  client: HttpClient,
  taskId: number,
  names: readonly string[],
  opts: LabelsDiffOpts = {},
): Promise<LabelsDiffResult> {
  if (names.length === 0) return { names: [], raw: null };
  const body = { labels: names.map((name) => ({ name })) };
  const raw = await client.request({
    method: 'POST',
    path: removeLabelsPath(taskId),
    body,
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { names: [...names], raw };
}
