import { type TasksRelationsData } from '../../api/schemas/task-relations.js';

/**
 * Human-mode renderer for `freelo tasks relations` (R38, spec 0052).
 *
 * Multi-line output. First line is the summary (count of relations),
 * subsequent lines are one per relation in `<type> → #<id> "<name>"`
 * form. Empty relations get a single "no relations." line.
 *
 * Examples:
 *   Task #4567 — 1 relation(s):
 *     blocks → #9876 "Ship the thing"
 *
 *   Task #4567 — no relations.
 */
export function renderTasksRelationsHuman(data: TasksRelationsData): string {
  if (data.relations.length === 0) {
    return `Task #${String(data.task_id)} — no relations.`;
  }
  const header = `Task #${String(data.task_id)} — ${String(data.relations.length)} relation(s):`;
  const lines = data.relations.map((r) => {
    const name = r.related_task_name ?? '';
    const namePart = name.length > 0 ? ` "${name}"` : '';
    return `  ${r.type} → #${String(r.related_task_id)}${namePart}`;
  });
  return [header, ...lines].join('\n');
}
