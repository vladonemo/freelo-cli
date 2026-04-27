import { type TasksDescriptionGetData } from '../../api/schemas/task-description.js';

/**
 * Human renderer for `freelo tasks description get`.
 *
 * Two-line block:
 *
 *   Task #<id> description:
 *   <content body — empty descriptions render "(empty)">
 *
 * `date_add` is included on a third line as `Updated <iso>` only when
 * non-null. Sync — no I/O, no lazy imports needed.
 *
 * Spec 0026 §3.2.
 */
export function renderTasksDescriptionGetHuman(data: TasksDescriptionGetData): string {
  const { task_id, description } = data;
  const content =
    typeof description.content === 'string' && description.content.length > 0
      ? description.content
      : '(empty)';
  const lines = [`Task #${task_id} description:`, content];
  if (typeof description.date_add === 'string' && description.date_add.length > 0) {
    lines.push(`Updated ${description.date_add}`);
  }
  return lines.join('\n');
}
