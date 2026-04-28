/**
 * Wire wrappers for the `time` resource group, R19 (spec 0030).
 *
 *   - `POST /timetracking/start` — start a singleton-per-user timer.
 *   - `GET /timetracking/status` — read the active timer (returns 204 when
 *     none is active; the shared HTTP client extension feeds `null` to the
 *     schema on 204, spec 0030 §2.5).
 *
 * Mirrors the structure of `addComment` / `editComment` byte-for-byte; only
 * the validating schema and the path differ.
 */

import { type ApiResponse, type HttpClient } from './client.js';
import {
  TimeEditResponseSchema,
  TimeStartResponseSchema,
  TimeStatusWireSchema,
  TimeStopResponseSchema,
  type TimeEditResponse,
  type TimeStartResponse,
  type TimeStatusWire,
  type TimeStopResponse,
} from './schemas/time.js';

/** Two-field opts shared by every `time` wire wrapper. */
export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  Path constants — exposed so dry-run envelopes echo paths without
 *  re-running the network branch.
 * ------------------------------------------------------------------------- */

export const START_TIMER_PATH = '/timetracking/start';
export const TIMER_STATUS_PATH = '/timetracking/status';
export const STOP_TIMER_PATH = '/timetracking/stop';
export const EDIT_TIMER_PATH = '/timetracking/edit';

/* ---------------------------------------------------------------------------
 *  POST /timetracking/start
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/timetracking/start` (yaml :2747-2760).
 *
 * `task_id` / `note` are documented in the OpenAPI request schema. The
 * additional `date_reported` field is documented in the endpoint's prose
 * (yaml :2744): *"defaults to 'now' (server time) if not provided. Passing
 * an explicit `date_reported` backdates the session's start time."* It is
 * surfaced via the `--at <ISO>` flag (R19.5, spec 0031). When `--at` is
 * omitted, the field MUST be absent from the body — not `null` — to keep
 * wire diffs identical to R19 for the unchanged path (spec 0031 §2.2 /
 * decision 5).
 */
export type StartTimerBody = {
  task_id?: number | null;
  note?: string | null;
  /** Canonical UTC ISO 8601 timestamp (`YYYY-MM-DDTHH:MM:SSZ`). Backdate the session start. */
  date_reported?: string;
};

/** CLI-side input shape passed to `buildStartTimerBody`. */
export type StartTimerInput = {
  taskId?: number;
  note?: string;
  /** Canonical UTC ISO 8601 string, already validated by `parseIsoTimestampFlag`. */
  dateReported?: string;
};

export type StartTimerOpts = FetchOpts & {
  body: StartTimerBody;
};

export type StartTimerResult = {
  response: TimeStartResponse;
  raw: ApiResponse<TimeStartResponse>;
};

/**
 * `POST /timetracking/start` — create a new running-work record. Returns the
 * server-issued `uuid`. Singleton per user: 409 if one is already running
 * (spec 0030 §2.4 — the leaf command rewrites that hint).
 *
 * Spec 0030 §3.2.
 */
export async function startTimer(
  client: HttpClient,
  opts: StartTimerOpts,
): Promise<StartTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: START_TIMER_PATH,
    body: opts.body,
    schema: TimeStartResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { response: raw.data, raw };
}

/**
 * Map CLI input → wire body. Pure function — no I/O.
 *
 * Omits keys not provided so the on-wire body matches Freelo's expectation
 * of "only send what you mean to set". A future v1.x can grow CLI-ergonomic
 * fields without touching the wire shape directly.
 */
export function buildStartTimerBody(input: StartTimerInput): StartTimerBody {
  const body: StartTimerBody = {};
  if (input.taskId !== undefined) body.task_id = input.taskId;
  if (input.note !== undefined) body.note = input.note;
  if (input.dateReported !== undefined) body.date_reported = input.dateReported;
  return body;
}

/* ---------------------------------------------------------------------------
 *  GET /timetracking/status
 * ------------------------------------------------------------------------- */

export type GetTimerStatusOpts = FetchOpts;

export type GetTimerStatusResult = {
  /** `null` when 204 No Content (no active timer); active session object otherwise. */
  status: TimeStatusWire;
  raw: ApiResponse<TimeStatusWire>;
};

/**
 * `GET /timetracking/status` — read the caller's currently-running session.
 *
 * **204 path:** the shared HTTP client extension (spec 0030 §2.5) feeds
 * `null` to the schema on 204 No Content. The leaf command treats `null`
 * as the "inactive" branch of the envelope discriminated union.
 *
 * Spec 0030 §3.2.
 */
export async function getTimerStatus(
  client: HttpClient,
  opts: GetTimerStatusOpts = {},
): Promise<GetTimerStatusResult> {
  const raw = await client.request({
    method: 'GET',
    path: TIMER_STATUS_PATH,
    schema: TimeStatusWireSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { status: raw.data, raw };
}

/* ---------------------------------------------------------------------------
 *  POST /timetracking/stop  (R20, spec 0032)
 *
 *  No request body — the endpoint always targets the caller's own active
 *  session (yaml :2793). 200 returns a `WorkReport`; 409 indicates no active
 *  session (caller's leaf rewrites the hint to point at `time start`).
 * ------------------------------------------------------------------------- */

export type StopTimerOpts = FetchOpts;

export type StopTimerResult = {
  workReport: TimeStopResponse;
  raw: ApiResponse<TimeStopResponse>;
};

/**
 * `POST /timetracking/stop` — finalize the active session as a work report.
 *
 * Returns the parsed `WorkReport` (yaml :2799-2803). 409 (no active session)
 * surfaces as `FreeloApiError` with `httpStatus: 409`; the leaf command
 * (`src/commands/time/stop.ts`) catches and rewrites `hintNext` to point at
 * `freelo time start` (spec 0032 §2.4).
 */
export async function stopTimer(
  client: HttpClient,
  opts: StopTimerOpts = {},
): Promise<StopTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: STOP_TIMER_PATH,
    // No body. Pass `undefined` so the client serializes nothing.
    schema: TimeStopResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { workReport: raw.data, raw };
}

/* ---------------------------------------------------------------------------
 *  POST /timetracking/edit  (R20, spec 0032)
 *
 *  Body: `{ task_id?: int|null, note?: str|null }` (yaml :2830-2843). Both
 *  fields are nullable. `task_id: null` disassociates the session from any
 *  task. 200 returns `{ uuid }`; 409 indicates no active session.
 *
 *  NOTE: Verb is **POST**, not PATCH (the roadmap typo). See spec 0032
 *  decision 8.
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/timetracking/edit`.
 *
 * Important: `task_id: null` is meaningful (disassociate from task), so this
 * type permits `null` as a distinct value. `buildEditTimerBody` includes the
 * key whenever the corresponding input is `!== undefined`, so `null` is sent
 * as `null` and absent stays absent.
 */
export type EditTimerBody = {
  task_id?: number | null;
  note?: string | null;
};

/**
 * CLI-side input shape passed to `buildEditTimerBody`.
 *
 * `taskId`:
 *   - `undefined` — neither `--task` nor `--no-task` supplied; key omitted.
 *   - `number`    — `--task <id>` supplied; sent as `task_id: <id>`.
 *   - `null`      — `--no-task` supplied; sent as `task_id: null` (disassociate).
 *
 * `note`:
 *   - `undefined` — `--note` not supplied; key omitted.
 *   - `string`    — `--note <str>` supplied; sent as `note: <str>` (empty
 *     string allowed — server accepts).
 */
export type EditTimerInput = {
  taskId?: number | null;
  note?: string;
};

export type EditTimerOpts = FetchOpts & {
  body: EditTimerBody;
};

export type EditTimerResult = {
  response: TimeEditResponse;
  raw: ApiResponse<TimeEditResponse>;
};

/**
 * `POST /timetracking/edit` — modify the running session's `task_id` and/or
 * `note` in flight (yaml :2811-2861). Spec 0032 §3.2.
 */
export async function editTimer(client: HttpClient, opts: EditTimerOpts): Promise<EditTimerResult> {
  const raw = await client.request({
    method: 'POST',
    path: EDIT_TIMER_PATH,
    body: opts.body,
    schema: TimeEditResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { response: raw.data, raw };
}

/**
 * Map CLI input → wire body. Pure function — no I/O.
 *
 * Includes a key only when the corresponding input is `!== undefined`. For
 * `taskId`, `null` is a valid value (disassociate from task) — the `!==
 * undefined` check preserves it on the wire.
 */
export function buildEditTimerBody(input: EditTimerInput): EditTimerBody {
  const body: EditTimerBody = {};
  if (input.taskId !== undefined) body.task_id = input.taskId;
  if (input.note !== undefined) body.note = input.note;
  return body;
}
