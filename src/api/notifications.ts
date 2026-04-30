/**
 * Wire wrappers for the `notifications` resource group, R28 (spec 0040).
 *
 * Three endpoints (yaml :3618-3753):
 *   - `GET /all-notifications`                              — paginated list
 *   - `POST /notification/{notification_id}/mark-read`      — flip is_unread → false
 *   - `POST /notification/{notification_id}/mark-unread`    — flip is_unread → true
 *
 * The two write endpoints are server-side idempotent. There is **no**
 * GET-single endpoint, so the CLI never pre-checks per-id state — see spec
 * 0040 decision 03.
 */

import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';
import {
  NotificationSchema,
  SuccessResponseSchema,
  type Notification,
} from './schemas/notification.js';
import { type NormalizedPage, normalizePaginated } from './pagination.js';
import { buildQuery } from '../lib/query.js';

/* ---------------------------------------------------------------------------
 *  Path helpers — exported so dry-run envelopes can echo paths without making
 *  a wire call.
 * ------------------------------------------------------------------------- */

export const ALL_NOTIFICATIONS_PATH = '/all-notifications';

export const markNotificationReadPath = (id: number): string => `/notification/${id}/mark-read`;

export const markNotificationUnreadPath = (id: number): string => `/notification/${id}/mark-unread`;

/* ---------------------------------------------------------------------------
 *  Shared opts shape.
 * ------------------------------------------------------------------------- */

export type FetchOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

/* ---------------------------------------------------------------------------
 *  GET /all-notifications  (yaml :3619-3694)
 *
 *  Filter map. Each key maps 1-1 to a Freelo wire parameter:
 *    - `onlyUnread` → `only_unread=1` (string; the live API ignores `true`)
 *    - `projects`   → `projects_ids[]`
 *    - `types`      → `notification_types[]`
 *
 *  v1 omits `users_ids[]`, `teams_uuids[]`, and `order` per spec 0040
 *  decision 04.
 * ------------------------------------------------------------------------- */

export type AllNotificationsFilters = {
  onlyUnread?: boolean;
  projects?: readonly number[];
  types?: readonly string[];
};

export type AllNotificationsOpts = FetchOpts & {
  /** 0-indexed page; mapped to `?p=N` on the wire. */
  page: number;
  filters: AllNotificationsFilters;
};

export type NotificationsListResult = {
  page: NormalizedPage<Notification>;
  raw: ApiResponse<unknown>;
};

/**
 * `GET /all-notifications?<query>` — paginated list of notifications addressed
 * to the calling user. Server-side ACL-filtered.
 *
 * Mirrors `getAllDocsAndFiles`: schema parses to `unknown`, then
 * `normalizePaginated` validates the wrapper and per-item shape against
 * `NotificationSchema` and returns a `NormalizedPage`.
 */
export async function getAllNotifications(
  client: HttpClient,
  opts: AllNotificationsOpts,
): Promise<NotificationsListResult> {
  const { filters } = opts;
  const params: Record<
    string,
    string | number | boolean | readonly (string | number)[] | undefined
  > = {
    p: opts.page,
  };
  if (filters.onlyUnread === true) {
    // WIRE QUIRK: the live Freelo API requires the string "1", not boolean true.
    // Sending `only_unread=true` is silently ignored. See skill SKILL.md and
    // docs/api/freelo-api.yaml (search WIRE QUIRK) for full details.
    params['only_unread'] = '1';
  }
  if (filters.projects !== undefined && filters.projects.length > 0) {
    params['projects_ids[]'] = filters.projects;
  }
  if (filters.types !== undefined && filters.types.length > 0) {
    params['notification_types[]'] = filters.types;
  }

  const qs = buildQuery(params);
  const path = qs.length > 0 ? `${ALL_NOTIFICATIONS_PATH}?${qs}` : ALL_NOTIFICATIONS_PATH;
  const raw = await client.request({
    method: 'GET',
    path,
    schema: z.unknown(),
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  const page = normalizePaginated(raw.data, 'notifications', NotificationSchema);
  return { page, raw };
}

/* ---------------------------------------------------------------------------
 *  POST /notification/{id}/mark-read   (yaml :3696-3724)
 *  POST /notification/{id}/mark-unread (yaml :3726-3753)
 *
 *  Both endpoints take no body and return the generic SuccessResponse
 *  envelope. Both are server-side idempotent.
 * ------------------------------------------------------------------------- */

export type MarkResult = {
  raw: ApiResponse<unknown>;
};

export async function markNotificationAsRead(
  client: HttpClient,
  id: number,
  opts: FetchOpts = {},
): Promise<MarkResult> {
  const raw = await client.request({
    method: 'POST',
    path: markNotificationReadPath(id),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}

export async function markNotificationAsUnread(
  client: HttpClient,
  id: number,
  opts: FetchOpts = {},
): Promise<MarkResult> {
  const raw = await client.request({
    method: 'POST',
    path: markNotificationUnreadPath(id),
    body: {},
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
