import { type TasksProjectRemoveData } from '../../api/schemas/task-projects.js';

/**
 * Human-mode renderer for `freelo tasks project remove` (R38, spec 0052).
 *
 * One terse line. Distinguishes the live-cleared, the already-removed
 * (defensive 404 / first-class idempotency yaml :1985), and the dry-run
 * paths.
 *
 * Examples:
 *   Task #4567 removed from project #42.
 *   Task #4567 was already removed from project #42.
 *   [dry-run] Task #4567 would be removed from project #42.
 */
export function renderTasksProjectRemoveHuman(data: TasksProjectRemoveData): string {
  if (data.would !== undefined) {
    return `[dry-run] Task #${String(data.task_id)} would be removed from project #${String(data.project_id)}.`;
  }
  if (data.already_in_target_state) {
    return `Task #${String(data.task_id)} was already removed from project #${String(data.project_id)}.`;
  }
  return `Task #${String(data.task_id)} removed from project #${String(data.project_id)}.`;
}
