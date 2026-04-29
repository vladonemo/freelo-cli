import { type TaskLabelsDetachData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels detach` (R24, spec 0036 §3.3).
 *
 * Live:    `Detached 2 task labels from task #7.`
 * Dry-run: `(dry-run) Would detach 2 task labels from task #7.`
 */
export function renderTaskLabelsDetachHuman(data: TaskLabelsDetachData): string {
  const noun = data.count === 1 ? 'task label' : 'task labels';
  if (data.would !== undefined) {
    return `(dry-run) Would detach ${data.count} ${noun} from task #${data.task_id}.`;
  }
  return `Detached ${data.count} ${noun} from task #${data.task_id}.`;
}
