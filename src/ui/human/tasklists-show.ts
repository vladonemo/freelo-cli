import { renderTable } from '../table.js';
import { type TasklistShowData } from '../../api/schemas/tasklist.js';

/**
 * Human renderer for `freelo tasklists show <id>`.
 *
 * Spec 0016 §3.4. Renders a header block summarising the tasklist's key
 * metadata, then — when `data.assignable_workers` is present — appends a
 * table of assignable workers.
 *
 * The renderer is async because it lazy-loads `cli-table3` via `renderTable`
 * for the workers table.
 */
export async function renderTasklistsShowHuman(data: TasklistShowData): Promise<string> {
  const lines: string[] = [];
  const tasklist = data.tasklist as Record<string, unknown>;

  const id = typeof tasklist['id'] === 'number' ? tasklist['id'] : '?';
  const name = typeof tasklist['name'] === 'string' ? tasklist['name'] : '';
  lines.push(`Tasklist: ${name} (#${id})`);

  const projectId = tasklist['project_id'];
  if (typeof projectId === 'number') {
    lines.push(`Project:  ${projectId}`);
  }

  const created = formatDateOnly(tasklist['date_add']);
  if (created !== '') lines.push(`Created:  ${created}`);

  const edited = formatDateOnly(tasklist['date_edited_at']);
  if (edited !== '') lines.push(`Edited:   ${edited}`);

  const tasks = tasklist['tasks'];
  if (Array.isArray(tasks)) {
    lines.push(`Tasks (embedded): ${tasks.length}`);
  }

  if (data.assignable_workers !== undefined) {
    lines.push('');
    lines.push('ASSIGNABLE WORKERS');
    if (data.assignable_workers.length === 0) {
      const empty = await renderTable(['ID', 'FULLNAME'], [['', '(no assignable workers)']], {
        nameColumnIndex: 1,
      });
      lines.push(empty.trimEnd());
    } else {
      const rows = data.assignable_workers.map((w) => [
        String(w.id),
        typeof w.fullname === 'string' ? w.fullname : '',
      ]);
      const table = await renderTable(['ID', 'FULLNAME'], rows, { nameColumnIndex: 1 });
      lines.push(table.trimEnd());
    }
  }

  return lines.join('\n');
}

function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value === '') return '';
  // ISO timestamp → date prefix only.
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return m?.[1] ?? value;
}
