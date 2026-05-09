import { type TasksProjectAddData } from '../../api/schemas/task-projects.js';

/**
 * Human-mode renderer for `freelo tasks project add` (R38, spec 0052).
 *
 * One terse line. Dry-run prefixes `[dry-run]` and uses "would be added".
 * Live mode renders the count of secondary projects added (= number of
 * tasklists; one assignment per tasklist).
 *
 * Examples:
 *   Task #4567 added to 2 project(s) via tasklist(s) #100, #200.
 *   Task #4567 added to 1 project(s) via tasklist(s) #100.
 *   [dry-run] Task #4567 would be added to 2 project(s) via tasklist(s) #100, #200.
 */
export function renderTasksProjectAddHuman(data: TasksProjectAddData): string {
  const dry = data.would !== undefined;
  const verb = dry ? 'would be added' : 'added';
  const prefix = dry ? '[dry-run] ' : '';
  const count = data.tasklist_ids.length;
  const list = data.tasklist_ids.map((id) => `#${String(id)}`).join(', ');
  return `${prefix}Task #${String(data.task_id)} ${verb} to ${String(count)} project(s) via tasklist(s) ${list}.`;
}
