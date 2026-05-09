import { type TasksFindRelationsData } from '../../api/schemas/task-relations.js';

/**
 * Human-mode renderer for `freelo tasks find-relations` (R38, spec 0052).
 *
 * Multi-line summary + per-task block. The summary line surfaces the
 * "<queried> task(s) queried, <visible> visible" gap so users notice
 * silently-omitted (inaccessible) tasks.
 *
 * Examples:
 *   3 task(s) queried, 2 visible:
 *     #4567 — 1 relation(s): blocks → #9876
 *     #4568 — no relations
 *
 *   1 task(s) queried, 1 visible:
 *     #4567 — no relations
 */
export function renderTasksFindRelationsHuman(data: TasksFindRelationsData): string {
  const queried = data.task_ids.length;
  const visible = data.tasks.length;
  const header = `${String(queried)} task(s) queried, ${String(visible)} visible:`;
  if (visible === 0) {
    return header;
  }
  const lines = data.tasks.map((t) => {
    if (t.relations.length === 0) {
      return `  #${String(t.task_id)} — no relations`;
    }
    const summary = t.relations.map((r) => `${r.type} → #${String(r.related_task_id)}`).join(', ');
    return `  #${String(t.task_id)} — ${String(t.relations.length)} relation(s): ${summary}`;
  });
  return [header, ...lines].join('\n');
}
