import { type TasksEstimateSetData } from '../../api/schemas/task-estimate.js';

/**
 * Human-mode renderer for `freelo tasks estimate set` (R37, spec 0051).
 *
 * One terse line. Distinguishes total scope (no `--user`) from per-user
 * scope. Dry-run prefixes `[dry-run]`.
 *
 * Examples:
 *   Total time estimate set on task #4567 to 120 min.
 *   Time estimate for user #42 set on task #4567 to 90 min.
 *   [dry-run] Total time estimate would be set on task #4567 to 120 min.
 *   [dry-run] Time estimate for user #42 would be set on task #4567 to 90 min.
 */
export function renderTasksEstimateSetHuman(data: TasksEstimateSetData): string {
  const dry = data.would !== undefined;
  const verb = dry ? 'would be set' : 'set';
  const subject =
    data.user_id === null
      ? 'Total time estimate'
      : `Time estimate for user #${String(data.user_id)}`;
  const prefix = dry ? '[dry-run] ' : '';
  return `${prefix}${subject} ${verb} on task #${String(data.task_id)} to ${String(data.minutes)} min.`;
}
