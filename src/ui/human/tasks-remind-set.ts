import { type TasksRemindSetData } from '../../api/schemas/task-reminder.js';

/**
 * Human-mode renderer for `freelo tasks remind set` (R35, spec 0049).
 *
 * One terse line. The task name is included in parentheses when the server
 * returned it; omitted entirely when null/missing rather than printing
 * "(null)" or an empty pair.
 *
 * Examples:
 *   Reminder set on task #4567 ("Review PR") for 2099-01-01T09:00:00Z.
 *   Reminder set on task #4567 for 2099-01-01T09:00:00Z.
 *   [dry-run] Reminder set on task #4567 for 2099-01-01T09:00:00Z.
 */
export function renderTasksRemindSetHuman(data: TasksRemindSetData): string {
  const name = data.task_name;
  const namePart = typeof name === 'string' && name.length > 0 ? ` ("${name}")` : '';
  const prefix = data.would !== undefined ? '[dry-run] ' : '';
  return `${prefix}Reminder set on task #${String(data.task_id)}${namePart} for ${data.remind_at}.`;
}
