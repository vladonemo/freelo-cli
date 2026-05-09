import { type TasksShareData } from '../../api/schemas/task-share.js';

/**
 * Human-mode renderer for `freelo tasks share` (R36, spec 0050).
 *
 * One terse line. The URL is the primary payload — humans copy it from
 * stdout. Dry-run is signalled with a `[dry-run]` prefix so it never
 * looks like a real URL was returned.
 *
 * Examples:
 *   Public link for task #4567: https://app.freelo.io/share/abc123
 *   [dry-run] Public link for task #4567 would be created at /public-link/task/4567.
 */
export function renderTasksShareHuman(data: TasksShareData): string {
  if (data.would !== undefined) {
    return `[dry-run] Public link for task #${String(data.task_id)} would be created at ${data.would.path}.`;
  }
  return `Public link for task #${String(data.task_id)}: ${data.url}`;
}
