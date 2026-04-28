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
  TimeStartResponseSchema,
  TimeStatusWireSchema,
  type TimeStartResponse,
  type TimeStatusWire,
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

/* ---------------------------------------------------------------------------
 *  POST /timetracking/start
 * ------------------------------------------------------------------------- */

/**
 * Wire-shape of the POST body for `/timetracking/start` (yaml :2747-2760).
 * Both fields are optional / nullable per the OpenAPI; v1 CLI surfaces both.
 */
export type StartTimerBody = {
  task_id?: number | null;
  note?: string | null;
};

/** CLI-side input shape passed to `buildStartTimerBody`. */
export type StartTimerInput = {
  taskId?: number;
  note?: string;
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
