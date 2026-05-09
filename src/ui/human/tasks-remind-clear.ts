import { type TasksRemindClearData } from '../../api/schemas/task-reminder.js';

/**
 * Human-mode renderer for `freelo tasks remind clear` (R35, spec 0049).
 *
 * One terse line. `already_in_target_state` distinguishes the (defensive)
 * "no reminder was set" path from the regular cleared path.
 *
 * Examples:
 *   Reminder cleared on task #4567.
 *   Reminder on task #4567 was already cleared.
 *   [dry-run] Reminder would be cleared on task #4567.
 */
export function renderTasksRemindClearHuman(data: TasksRemindClearData): string {
  if (data.would !== undefined) {
    return `[dry-run] Reminder would be cleared on task #${String(data.task_id)}.`;
  }
  if (data.already_in_target_state) {
    return `Reminder on task #${String(data.task_id)} was already cleared.`;
  }
  return `Reminder cleared on task #${String(data.task_id)}.`;
}
