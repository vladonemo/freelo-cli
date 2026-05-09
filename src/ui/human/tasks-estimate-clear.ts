import { type TasksEstimateClearData } from '../../api/schemas/task-estimate.js';

/**
 * Human-mode renderer for `freelo tasks estimate clear` (R37, spec 0051).
 *
 * One terse line. Distinguishes total scope (no `--user`) from per-user
 * scope, and the "already cleared" defensive-404 path from the regular
 * cleared path. Dry-run prefixes `[dry-run]`.
 *
 * Examples:
 *   Total time estimate cleared on task #4567.
 *   Time estimate for user #42 cleared on task #4567.
 *   Total time estimate on task #4567 was already cleared.
 *   Time estimate for user #42 on task #4567 was already cleared.
 *   [dry-run] Total time estimate would be cleared on task #4567.
 *   [dry-run] Time estimate for user #42 would be cleared on task #4567.
 */
export function renderTasksEstimateClearHuman(data: TasksEstimateClearData): string {
  const subject =
    data.user_id === null
      ? 'Total time estimate'
      : `Time estimate for user #${String(data.user_id)}`;

  if (data.would !== undefined) {
    return `[dry-run] ${subject} would be cleared on task #${String(data.task_id)}.`;
  }
  if (data.already_in_target_state) {
    return `${subject} on task #${String(data.task_id)} was already cleared.`;
  }
  return `${subject} cleared on task #${String(data.task_id)}.`;
}
