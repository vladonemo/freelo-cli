import { type ApiResponse, type HttpClient } from './client.js';
import {
  EditTasklistResponseSchema,
  type EditTasklistBody,
  type EditTasklistInput,
  type EditTasklistResponse,
} from './schemas/tasklist.js';

/**
 * M02 — `freelo tasklists edit <id>` (spec 0065).
 *
 * Single endpoint: `POST /tasklist/{tasklist_id}/edit` (yaml :1235-1305).
 * No lookup GET, no refresh GET — the edit response carries no entity and
 * `GET /tasklist/{id}` would not echo the budget anyway (decision 6).
 */

/**
 * Map the CLI input shape to the Freelo wire body.
 *
 * Pure function — no I/O, no global state. Unit-tested without MSW.
 *
 * Rules:
 *  - Only keys the user actually set are emitted; `undefined` is never
 *    serialized, so an omitted flag leaves the field untouched server-side.
 *  - Each `clear*` flag emits the documented clearing value rather than
 *    dropping the key: `budget: null`, `time_budget_minutes: null`,
 *    `worker_id: null`, `tracking_users_ids: []`.
 *  - `timeBudgetMinutes: 0` emits `0` — a zero fund is a real value and is
 *    NOT the same as a clear (yaml declares `minimum: 0`).
 *  - `trackingUsers` is deduped, first-seen order preserved (decision 7):
 *    the wire field is a set, and a stable order keeps the `applied_changes`
 *    echo deterministic.
 *  - `should_change_existing_tasks` is emitted only when opted in; the
 *    server default is `false` (yaml :1287), so omitting it is equivalent
 *    and keeps the body minimal.
 *
 * Mutex pairs (`--budget` vs `--clear-budget` etc.) are rejected by the
 * command layer before this is called; if both somehow arrive, the explicit
 * value wins over the clear so the builder stays total.
 *
 * Spec 0065 §4.
 */
export function buildEditTasklistBody(input: EditTasklistInput): EditTasklistBody {
  const body: EditTasklistBody = {};

  if (input.name !== undefined) body.name = input.name;

  if (input.budget !== undefined) {
    body.budget = input.budget;
  } else if (input.clearBudget === true) {
    body.budget = null;
  }

  if (input.timeBudgetMinutes !== undefined) {
    body.time_budget_minutes = input.timeBudgetMinutes;
  } else if (input.clearTimeBudget === true) {
    body.time_budget_minutes = null;
  }

  if (input.priority !== undefined) body.priority = input.priority;

  if (input.trackingUsers !== undefined) {
    body.tracking_users_ids = dedupePreserve(input.trackingUsers);
  } else if (input.clearTrackingUsers === true) {
    body.tracking_users_ids = [];
  }

  if (input.shouldChangeExistingTasks === true) {
    body.should_change_existing_tasks = true;
  }

  if (input.worker !== undefined) {
    body.worker_id = input.worker;
  } else if (input.clearWorker === true) {
    body.worker_id = null;
  }

  return body;
}

/** Dedupe preserving first-seen order. Mirrors R10's helper of the same name. */
function dedupePreserve(ids: readonly number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * True when the builder produced no mutating keys.
 *
 * `should_change_existing_tasks` is explicitly NOT counted as mutating: on
 * its own it is a modifier with nothing to modify, and the server ignores it
 * silently. The command layer rejects that combination up front (spec 0065
 * §5 rule 10); this helper agrees with that rule so the two cannot drift.
 */
export function isEmptyEditBody(body: EditTasklistBody): boolean {
  return Object.keys(body).every((k) => k === 'should_change_existing_tasks');
}

/**
 * Build the wire path for `POST /tasklist/{tasklist_id}/edit`. Centralised so
 * `--dry-run` echoes the exact same string the live call would use, without
 * rebuilding it. No URL-encoding needed — the caller validates the id is a
 * positive integer.
 */
export function editTasklistPath(tasklistId: number): string {
  return `/tasklist/${tasklistId}/edit`;
}

export type EditTasklistOpts = {
  tasklistId: number;
  body: EditTasklistBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type EditTasklistResult = {
  /** Parsed response. `priorityApplied` is guaranteed present by the schema. */
  response: EditTasklistResponse;
  raw: ApiResponse<EditTasklistResponse>;
};

/**
 * `POST /tasklist/{tasklist_id}/edit` — partial update of a tasklist.
 *
 * The response is validated through `EditTasklistResponseSchema`, so a 200
 * missing the required `priorityApplied` surfaces as a `FreeloApiError`
 * (`VALIDATION_ERROR`, exit 4) rather than being silently coerced. Rate-limit
 * and request-id metadata live on `raw` for the leaf command to put in the
 * envelope.
 *
 * Spec 0065 §4 / yaml :1235-1305.
 */
export async function editTasklist(
  client: HttpClient,
  opts: EditTasklistOpts,
): Promise<EditTasklistResult> {
  const raw = await client.request({
    method: 'POST',
    path: editTasklistPath(opts.tasklistId),
    body: opts.body,
    schema: EditTasklistResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { response: raw.data, raw };
}
