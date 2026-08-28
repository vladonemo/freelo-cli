import { type CommentsDeleteData } from '../../api/schemas/comment.js';

/**
 * Human renderer for `freelo comments delete` (M01, spec 0061).
 *
 * Two shapes, gated on `data.would`:
 *   - Live success:    `Deleted comment #ID.`
 *   - Dry-run (would): `(dry-run) Would delete comment #ID.`
 *
 * There is deliberately **no** "was already deleted" shape. Unlike
 * `tasks delete` (R13), this command never absorbs a 404 into an idempotent
 * success, so `already_in_target_state` is unreachable-true in v1 (spec 0061
 * §5.1 / decision 1). A third branch here would be dead code and a permanent
 * coverage hole (calibration §4).
 *
 * Spec 0061 §6.2.
 */
export function renderCommentsDeleteHuman(data: CommentsDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete comment #${data.comment_id}.`;
  }
  return `Deleted comment #${data.comment_id}.`;
}
