import {
  type NotificationsReadData,
  type NotificationsUnreadData,
} from '../../api/schemas/notification.js';

/**
 * Human renderer for `freelo notifications read` and
 * `freelo notifications unread` (R28, spec 0040).
 *
 * Three shapes, gated on `data.would` and `data.notification_id`:
 *   - Live success:        `Marked notification #ID as read.` /
 *                          `Marked notification #ID as unread.`
 *   - Dry-run (would):     `(dry-run) Would mark notification #ID as read.`
 *   - Empty `--all-unread`:  `No unread notifications.` (the
 *                          `notification_id` field is absent)
 *
 * Spec 0040 §3.5.2 / §3.9.
 */
export function renderNotificationsMarkHuman(
  data: NotificationsReadData | NotificationsUnreadData,
  verb: 'read' | 'unread',
): string {
  // Empty --all-unread notice envelope: no notification_id, no would.
  if (data.notification_id === undefined) {
    return verb === 'read' ? 'No unread notifications.' : 'No notifications matched.';
  }

  if (data.would !== undefined) {
    return `(dry-run) Would mark notification #${data.notification_id} as ${verb}.`;
  }
  return `Marked notification #${data.notification_id} as ${verb}.`;
}

/**
 * Render an error envelope for a single batch line/id in `human` mode.
 * Format: `Failed item N (id=ID): <message>`. `inputIndex` is 0-indexed; the
 * displayed number is 1-indexed for human eyes. Mirrors R11's batch-error
 * renderer.
 */
export function renderBatchItemFailureHuman(
  inputIndex: number,
  notificationId: number | null,
  message: string,
): string {
  const idPart = notificationId === null ? '' : ` (id=${notificationId})`;
  return `Failed item ${inputIndex + 1}${idPart}: ${message}`;
}
