import { type ApiResponse, type HttpClient } from './client.js';
import {
  ClearReminderResponseSchema,
  SetReminderResponseSchema,
  type SetReminderResponse,
} from './schemas/task-reminder.js';

/**
 * Wire wrappers for R35 `tasks remind` (spec 0049).
 *
 *   - `POST /task/{task_id}/reminder` — set / overwrite caller's reminder.
 *     OpenAPI :2067-2115. Body: `{ remind_at: <ISO 8601 string> }`.
 *   - `DELETE /task/{task_id}/reminder` — clear caller's reminder.
 *     OpenAPI :2116-2135. No body. 200 even when no reminder existed
 *     (server is idempotent — yaml :2125).
 *
 * The CLI does **not** rely on a 404 on DELETE to detect already-cleared:
 * the documented behavior is 200 either way. The defensive 404 catch lives
 * at the command layer (mirrors `tasks-delete.ts`) for forward-compat.
 */

export type SetReminderOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type SetReminderResult = {
  raw: ApiResponse<SetReminderResponse>;
  body: SetReminderResponse;
};

export type ClearReminderOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type ClearReminderResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for both verbs. Exposed so `--dry-run` envelopes can
 * echo the path without re-running the live branch.
 */
export function reminderPath(taskId: number): string {
  return `/task/${taskId}/reminder`;
}

/**
 * `POST /task/{task_id}/reminder` — set (or overwrite) the caller's reminder.
 *
 * Upsert semantics on the server side (yaml :2081): a second call on the
 * same task overwrites the prior `remind_at`. `remind_at` MUST be a
 * canonical UTC ISO 8601 string (`YYYY-MM-DDTHH:MM:SSZ`); the command
 * layer's `parseIsoTimestampFutureFlag` produces this shape.
 */
export async function setReminder(
  client: HttpClient,
  taskId: number,
  remindAt: string,
  opts: SetReminderOpts = {},
): Promise<SetReminderResult> {
  const raw = await client.request({
    method: 'POST',
    path: reminderPath(taskId),
    body: { remind_at: remindAt },
    schema: SetReminderResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw, body: raw.data };
}

/**
 * `DELETE /task/{task_id}/reminder` — remove the caller's reminder.
 *
 * Empty body. Server returns 200 with `SuccessResponse` even when no
 * reminder was set (yaml :2125 — idempotent). The defensive 404 path is
 * handled at the command layer, not here.
 */
export async function clearReminder(
  client: HttpClient,
  taskId: number,
  opts: ClearReminderOpts = {},
): Promise<ClearReminderResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: reminderPath(taskId),
    schema: ClearReminderResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
