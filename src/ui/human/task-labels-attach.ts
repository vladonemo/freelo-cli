import { type TaskLabelsAttachData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels attach` (R24, spec 0036 §3.3).
 *
 * Live:    `Attached 2 task labels to task #7.`
 * Dry-run: `(dry-run) Would attach 2 task labels to task #7.`
 *
 * The data shape carries `labels[]` with mixed `{ uuid? | name? | color? }`
 * entries — too varied to enumerate cleanly in human mode. Count is the
 * scannable summary; agents read JSON for detail.
 */
export function renderTaskLabelsAttachHuman(data: TaskLabelsAttachData): string {
  const noun = data.count === 1 ? 'task label' : 'task labels';
  if (data.would !== undefined) {
    return `(dry-run) Would attach ${data.count} ${noun} to task #${data.task_id}.`;
  }
  return `Attached ${data.count} ${noun} to task #${data.task_id}.`;
}
