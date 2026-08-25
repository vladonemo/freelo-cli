import { renderTable, truncateCell } from '../table.js';
import { type TaskLabelsFindData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels find` (M04, spec 0062 §2).
 *
 * Columns:
 *   - `uuid` — the label's UUID, the identifier `task-labels attach --uuid`
 *     takes. This is the whole point of the command.
 *   - `name` — label name (truncated at 40 chars)
 *   - `color` — hex color or `-`
 *
 * No `id` column: `TaskLabel` (OpenAPI :5949-5958) has no `id` field —
 * task labels are uuid-keyed. The id-keyed ones are project-labels, rendered
 * by `labels-list.ts`. Spec 0062 §3.2.
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` — cold-path
 * agents must not pay for it (mirrors `labels-list.ts`).
 */
export async function renderTaskLabelsFindHuman(data: TaskLabelsFindData): Promise<string> {
  const headers = ['UUID', 'NAME', 'COLOR'];
  if (data.labels.length === 0) {
    return renderTable(headers, [['', '(no task labels)', '']], {
      nameColumnIndex: 1,
    });
  }
  const rows = data.labels.map((l) => [
    l.uuid ?? '-',
    truncateCell(l.name ?? '', 40),
    l.color ?? '-',
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 1, maxNameWidth: 40 });
}
