import { type TasksUnshareData } from '../../api/schemas/task-share.js';

/**
 * Human-mode renderer for `freelo tasks unshare` (R36, spec 0050).
 *
 * One terse line. `already_in_target_state` distinguishes the (defensive)
 * "no link existed" path from the regular revoked path.
 *
 * Examples:
 *   Public link revoked on task #4567.
 *   Public link on task #4567 was already revoked.
 *   [dry-run] Public link on task #4567 would be revoked.
 */
export function renderTasksUnshareHuman(data: TasksUnshareData): string {
  if (data.would !== undefined) {
    return `[dry-run] Public link on task #${String(data.task_id)} would be revoked.`;
  }
  if (data.already_in_target_state) {
    return `Public link on task #${String(data.task_id)} was already revoked.`;
  }
  return `Public link revoked on task #${String(data.task_id)}.`;
}
