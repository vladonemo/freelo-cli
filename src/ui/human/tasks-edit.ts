import { type TasksEditData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks edit` (R10).
 *
 * Two shapes:
 *   - Live success: `Edited task #ID: <changed groups>.`
 *   - Dry-run:      `(dry-run) Would edit task #ID: <changed groups>.`
 *
 * "Changed groups" is a comma-list assembled from `applied_changes`:
 *   - Each top-level edit-body field that was set is named individually
 *     (`name`, `priority`, `worker`, `due`).
 *   - Label additions/removals collapse to `labels (+a -b)` only when
 *     non-empty.
 *
 * Spec 0020 §3.7.
 */
export function renderTasksEditHuman(taskId: number, data: TasksEditData): string {
  const changedGroups: string[] = [];
  const editKeys = Object.keys(data.applied_changes.edit);
  for (const key of editKeys) {
    // Wire keys → human-friendly labels.
    if (key === 'priority_enum') changedGroups.push('priority');
    else if (key === 'due_date') changedGroups.push('due');
    else changedGroups.push(key);
  }
  const added = data.applied_changes.labels_added;
  const removed = data.applied_changes.labels_removed;
  if (added.length > 0 || removed.length > 0) {
    const parts: string[] = [];
    if (added.length > 0) parts.push(`+${added.join(', +')}`);
    if (removed.length > 0) parts.push(`-${removed.join(', -')}`);
    changedGroups.push(`labels (${parts.join(' ')})`);
  }
  const groups = changedGroups.length > 0 ? changedGroups.join(', ') : '(no changes)';
  if (data.would !== undefined) {
    return `(dry-run) Would edit task #${taskId}: ${groups}.`;
  }
  return `Edited task #${taskId}: ${groups}.`;
}
