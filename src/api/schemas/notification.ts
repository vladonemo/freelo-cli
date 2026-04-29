/**
 * Zod schemas for the `notifications` resource group, R28 (spec 0040).
 *
 * Wire endpoints (yaml :3618-3753):
 *   - `GET /all-notifications`                                — paginated list
 *   - `POST /notification/{notification_id}/mark-as-read`     — flip is_unread → false
 *   - `POST /notification/{notification_id}/mark-as-unread`   — flip is_unread → true
 *
 * The two write endpoints are server-side idempotent (yaml :3709, :3739) and
 * return the generic `SuccessResponse` envelope. There is **no** GET-single
 * endpoint for notifications, so the CLI cannot pre-check current state per id
 * — it always POSTs and reports `posted: true` (spec 0040 decision 03).
 *
 * `Notification` is permissive (`.passthrough()`); every leaf except `id` is
 * `.nullable().optional()` per the project's permissive-schema policy
 * (R05.5 lessons / spec 0010 decision 1).
 */

import { z } from 'zod';
import { UserBasicSchema } from './project.js';

/* ---------------------------------------------------------------------------
 *  Generic Freelo success envelope (mirrors the local pattern in
 *  `src/api/project-labels.ts`, `src/api/task-labels.ts`).
 * ------------------------------------------------------------------------- */

export const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();
export type SuccessResponse = z.infer<typeof SuccessResponseSchema>;

/* ---------------------------------------------------------------------------
 *  Notification entity (yaml :5841-5901)
 *
 *  Required: `id` only. Every other field is `.nullable().optional()`.
 *  Passthrough so future server-side additions don't break us.
 * ------------------------------------------------------------------------- */

const RefSchema = z
  .object({
    id: z.number().int().nullable().optional(),
    name: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const NotificationFileSchema = z
  .object({
    uuid: z.string().nullable().optional(),
    filename: z.string().nullable().optional(),
    caption: z.string().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

const NotificationCommentSchema = z
  .object({
    id: z.number().int().nullable().optional(),
  })
  .passthrough()
  .nullable()
  .optional();

export const NotificationSchema = z
  .object({
    id: z.number().int(),
    type: z.string().nullable().optional(),
    date_action: z.string().nullable().optional(),
    author: UserBasicSchema.nullable().optional(),
    who: UserBasicSchema.nullable().optional(),
    is_unread: z.boolean().nullable().optional(),
    is_new: z.boolean().nullable().optional(),
    task: RefSchema,
    tasklist: RefSchema,
    project: RefSchema,
    comment: NotificationCommentSchema,
    document: RefSchema,
    file: NotificationFileSchema,
    more_comments: z.boolean().nullable().optional(),
    more_users: z.array(UserBasicSchema).nullable().optional(),
  })
  .passthrough();
export type Notification = z.infer<typeof NotificationSchema>;

/* ---------------------------------------------------------------------------
 *  Envelope `applied_filters` echo (notifications list).
 *  Only keys the user explicitly set are emitted. Mirrors `files-list`
 *  conventions.
 * ------------------------------------------------------------------------- */

export const NotificationsListAppliedFiltersSchema = z.object({
  only_unread: z.literal(true).optional(),
  projects: z.array(z.number().int()).optional(),
  types: z.array(z.string()).optional(),
});
export type NotificationsListAppliedFilters = z.infer<typeof NotificationsListAppliedFiltersSchema>;

/* ---------------------------------------------------------------------------
 *  freelo.notifications.list/v1 — envelope `data` shape
 * ------------------------------------------------------------------------- */

export const NotificationsListDataSchema = z.object({
  applied_filters: NotificationsListAppliedFiltersSchema,
  items: z.array(NotificationSchema),
});
export type NotificationsListData = z.infer<typeof NotificationsListDataSchema>;

/* ---------------------------------------------------------------------------
 *  Shared `would` shape for per-id dry-run envelopes (read / unread).
 *  Body is always `{}` — the wire endpoint takes no request body.
 * ------------------------------------------------------------------------- */

const WouldSchema = z
  .object({
    method: z.literal('POST'),
    path: z.string(),
    body: z.unknown(),
  })
  .optional();

/* ---------------------------------------------------------------------------
 *  freelo.notifications.read/v1 and .unread/v1 — per-id envelope `data`.
 *
 *  No `already_in_target_state` field — the CLI cannot pre-check state
 *  (no GET-single endpoint). Server is server-side idempotent; agents that
 *  need the signal observe `is_unread` via `notifications list`.
 *
 *  `items` is present only on the special "no unread to mark" notice envelope
 *  emitted when `--all-unread` resolves to zero ids (decision 06). Permissive
 *  passthrough so that deviation is valid against the schema.
 *
 *  `source: 'all-unread'` is present only on per-id envelopes that came from
 *  the `--all-unread` flow (read.ts only).
 * ------------------------------------------------------------------------- */

export const NotificationsReadDataSchema = z
  .object({
    notification_id: z.number().int().optional(),
    posted: z.boolean().optional(),
    source: z.literal('all-unread').optional(),
    line_index: z.number().int().min(0).optional(),
    input_index: z.number().int().min(0).optional(),
    items: z.array(z.never()).optional(),
    would: WouldSchema,
  })
  .passthrough();
export type NotificationsReadData = z.infer<typeof NotificationsReadDataSchema>;

export const NotificationsUnreadDataSchema = z
  .object({
    notification_id: z.number().int(),
    posted: z.boolean().optional(),
    line_index: z.number().int().min(0).optional(),
    input_index: z.number().int().min(0).optional(),
    would: WouldSchema,
  })
  .passthrough();
export type NotificationsUnreadData = z.infer<typeof NotificationsUnreadDataSchema>;
