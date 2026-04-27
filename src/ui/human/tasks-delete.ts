import { type TasksDeleteData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks delete` (R13, spec 0024).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:        `Deleted task #ID.`
 *   - Already deleted:     `Task #ID was already deleted.`
 *   - Dry-run (would):     `(dry-run) Would delete task #ID.`
 *
 * Spec 0024 §3.6.
 */
export function renderTasksDeleteHuman(data: TasksDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete task #${data.task_id}.`;
  }
  if (data.already_in_target_state) {
    return `Task #${data.task_id} was already deleted.`;
  }
  return `Deleted task #${data.task_id}.`;
}
