import { type ApiResponse, type HttpClient } from './client.js';
import {
  TaskcheckSuccessSchema,
  type EditTaskcheckBody,
  type EditTaskcheckInput,
} from './schemas/taskcheck.js';

/**
 * Wire wrappers for M03 — `freelo taskchecks edit|delete|finish|reopen`
 * (spec 0066).
 *
 * Four endpoints, all keyed by `tasks_checks.id`:
 *
 *   - `POST   /taskcheck/{id}`          edit      yaml :2118-2155
 *   - `DELETE /taskcheck/{id}`          delete    yaml :2156-2171
 *   - `POST   /taskcheck/{id}/finish`   finish    yaml :2173-2204
 *   - `POST   /taskcheck/{id}/activate` reopen    yaml :2206-2222
 *
 * **Request bodies are not uniform across the four** (decision 3). The
 * roadmap claimed all four take `notify_author`; the OpenAPI contract says
 * only `edit` (`required: true`) and `finish` (`required: false`) declare a
 * `requestBody` at all. `delete` and `activate` declare none, so this module
 * sends none — inventing a body for them would be guessing at API behavior.
 *
 * **No 404 handling here.** All four return 404 when handed a *smart*
 * taskcheck id (yaml :2124, :2161, :2179, :2212). `FreeloApiError` bubbles
 * untouched; the message/hint rewriting lives in the command layer so these
 * wrappers stay reusable. It is never converted into a success — spec 0066
 * §5.1 / decision 4.
 *
 * **No pre-check GET anywhere**, because there is no `GET /taskcheck/{id}` to
 * pre-check with. See `schemas/taskcheck.ts` and decision 5.
 */

/* ---------------------------------------------------------------------------
 *  Path builders
 *
 *  Exposed so `--dry-run` envelopes echo the exact string the live call would
 *  use, without re-running the network branch (mirrors R13's `deletePath` and
 *  M07's `deleteFilePath`). Ids are validated as positive integers by the
 *  command layer before they get here, so there is no path-injection surface.
 * ------------------------------------------------------------------------- */

export function editTaskcheckPath(taskcheckId: number): string {
  return `/taskcheck/${taskcheckId}`;
}

export function deleteTaskcheckPath(taskcheckId: number): string {
  return `/taskcheck/${taskcheckId}`;
}

/** `finish` → `/finish`, `reopen` → `/activate` (the wire verb differs from the CLI verb). */
export function transitionTaskcheckPath(taskcheckId: number, verb: TaskcheckVerb): string {
  return `/taskcheck/${taskcheckId}/${verb === 'finish' ? 'finish' : 'activate'}`;
}

/** CLI-level verb. The wire path for `reopen` is `/activate`. */
export type TaskcheckVerb = 'finish' | 'reopen';

/* ---------------------------------------------------------------------------
 *  Pure body builder
 * ------------------------------------------------------------------------- */

/**
 * Map CLI input → wire body for `POST /taskcheck/{id}`.
 *
 * Pure function — no I/O, no global state. Unit-tested without MSW.
 *
 * Rules (mirroring `buildEditTasklistBody`):
 *   - Only keys the user actually set are emitted.
 *   - `clearWorker` emits `worker: null`, the documented clearing value
 *     (yaml :2140), rather than dropping the key.
 *   - `notifyAuthor` emits `notify_author: true`; `false` is the server
 *     default, so the key is omitted when unset rather than sent as `false`.
 *
 * The `--worker` / `--clear-worker` mutex is rejected by the command layer
 * before this runs; if both somehow arrive, the explicit value wins so the
 * builder stays total.
 */
export function buildEditTaskcheckBody(input: EditTaskcheckInput): EditTaskcheckBody {
  const body: EditTaskcheckBody = {};

  if (input.name !== undefined) body.name = input.name;

  if (input.worker !== undefined) {
    body.worker = input.worker;
  } else if (input.clearWorker === true) {
    body.worker = null;
  }

  if (input.notifyAuthor === true) body.notify_author = true;

  return body;
}

/**
 * True when the builder produced no **mutating** keys.
 *
 * `notify_author` is explicitly not counted: on its own it is a modifier on a
 * change with nothing to modify. The command layer rejects that combination up
 * front (spec 0066 §4.1), and this helper agrees with that rule so the two
 * cannot drift. Mirrors `isEmptyEditBody` in `src/api/tasklists-edit.ts:102`.
 */
export function isEmptyEditTaskcheckBody(body: EditTaskcheckBody): boolean {
  return Object.keys(body).every((k) => k === 'notify_author');
}

/* ---------------------------------------------------------------------------
 *  Wire calls
 * ------------------------------------------------------------------------- */

export type EditTaskcheckOpts = {
  taskcheckId: number;
  body: EditTaskcheckBody;
  signal?: AbortSignal;
  requestId?: string;
};

export type TaskcheckCallResult = {
  raw: ApiResponse<unknown>;
};

/**
 * `POST /taskcheck/{taskcheck_id}` — rename a simple checklist item and/or
 * (re)assign its worker.
 *
 * `requestBody` is `required: true` on this operation, which is why the command
 * layer refuses an edit with no mutating flag rather than sending `{}`.
 */
export async function editTaskcheck(
  client: HttpClient,
  opts: EditTaskcheckOpts,
): Promise<TaskcheckCallResult> {
  const raw = await client.request({
    method: 'POST',
    path: editTaskcheckPath(opts.taskcheckId),
    body: opts.body,
    schema: TaskcheckSuccessSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

export type DeleteTaskcheckOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * `DELETE /taskcheck/{taskcheck_id}` — soft-delete a simple checklist item.
 *
 * No body: the operation declares no `requestBody` (yaml :2156-2171). There is
 * no undelete endpoint.
 */
export async function deleteTaskcheck(
  client: HttpClient,
  taskcheckId: number,
  opts: DeleteTaskcheckOpts = {},
): Promise<TaskcheckCallResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteTaskcheckPath(taskcheckId),
    schema: TaskcheckSuccessSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

export type TransitionTaskcheckOpts = {
  taskcheckId: number;
  verb: TaskcheckVerb;
  /**
   * Only honoured for `finish`. `POST /taskcheck/{id}/activate` declares no
   * request body, so `reopen` sends none regardless of this value — the
   * command layer never sets it for `reopen`, and this wrapper enforces it
   * anyway so the two cannot drift.
   */
  notifyAuthor?: true;
  signal?: AbortSignal;
  requestId?: string;
};

/**
 * `POST /taskcheck/{id}/finish` or `POST /taskcheck/{id}/activate`.
 *
 * The CLI makes no claim about whether repeating a transition is a server-side
 * no-op — the yaml does not say, and there is no way to observe prior state
 * (spec 0066 §5.2). A 200 is reported as success; anything else surfaces as
 * the corresponding typed error.
 */
export async function transitionTaskcheck(
  client: HttpClient,
  opts: TransitionTaskcheckOpts,
): Promise<TaskcheckCallResult> {
  const sendBody = opts.verb === 'finish' && opts.notifyAuthor === true;
  const raw = await client.request({
    method: 'POST',
    path: transitionTaskcheckPath(opts.taskcheckId, opts.verb),
    ...(sendBody ? { body: { notify_author: true } } : {}),
    schema: TaskcheckSuccessSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
