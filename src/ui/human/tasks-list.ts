import { renderTable } from '../table.js';
import { type TaskListData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks list`.
 *
 * Spec 0017 §2.7: default columns vary by `entity_shape`. The renderer:
 *  - summarizes `worker.fullname` (fallback to `String(worker.id)` per
 *    R05.5 spec 0015 §1 for users without a fullname),
 *  - summarizes `project.name`, `tasklist.name`, `state.state`,
 *  - emits `(no tasks)` for empty results,
 *  - delegates column truncation to `renderTable`.
 *
 * `displayFields`, when non-empty, drives column ordering instead of the
 * default set. Field names follow wire snake_case.
 */
const TASK_FULL_DEFAULT_COLUMNS: readonly string[] = [
  'id',
  'name',
  'project',
  'tasklist',
  'worker',
  'due_date',
  'state',
];

const TASK_SUMMARY_DEFAULT_COLUMNS: readonly string[] = [
  'id',
  'name',
  'worker',
  'due_date',
  'count_comments',
];

const TASK_FINISHED_DEFAULT_COLUMNS: readonly string[] = [
  'id',
  'name',
  'worker',
  'date_finished',
  'finished_by',
];

export async function renderTasksListHuman(
  data: TaskListData,
  opts: { displayFields?: readonly string[] } = {},
): Promise<string> {
  const defaults =
    data.entity_shape === 'task_full'
      ? TASK_FULL_DEFAULT_COLUMNS
      : data.entity_shape === 'task_summary'
        ? TASK_SUMMARY_DEFAULT_COLUMNS
        : TASK_FINISHED_DEFAULT_COLUMNS;

  const fields =
    opts.displayFields && opts.displayFields.length > 0 ? opts.displayFields : defaults;

  const headers = fields.map((f) => f.toUpperCase());
  const nameIdx = fields.indexOf('name');

  if (data.tasks.length === 0) {
    const empty = fields.map((f) => (f === 'name' ? '(no tasks)' : ''));
    return renderTable(headers, [empty], {
      ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
    });
  }

  const rows = data.tasks.map((t) => fields.map((f) => formatCell(t, f)));
  return renderTable(headers, rows, {
    ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
  });
}

/**
 * Format a single field value for human-mode rendering.
 *
 * `worker` / `author` / `finished_by` summarized to `fullname` (with id
 * fallback). `project` / `tasklist` summarized to `name`. `state` to its
 * `state` string. Time-estimates summarized to a `<minutes>m` shorthand.
 */
function formatCell(task: Record<string, unknown>, field: string): string {
  const value = task[field];
  if (value === undefined || value === null) return '';

  if (
    (field === 'worker' || field === 'author' || field === 'finished_by') &&
    typeof value === 'object'
  ) {
    const u = value as { fullname?: string | null; id?: number | string };
    if (u.fullname !== undefined && u.fullname !== null && u.fullname !== '') return u.fullname;
    if (u.id !== undefined) return String(u.id);
    return '';
  }
  if ((field === 'project' || field === 'tasklist') && typeof value === 'object') {
    const p = value as { name?: string };
    return p.name ?? '';
  }
  if (field === 'state' && typeof value === 'object') {
    const s = value as { state?: string };
    return s.state ?? '';
  }
  if (
    (field === 'total_time_estimate' || field === 'users_time_estimates') &&
    typeof value === 'object'
  ) {
    if (Array.isArray(value)) return value.length === 0 ? '' : `${value.length} entr(ies)`;
    const t = value as { minutes?: number };
    return t.minutes !== undefined ? `${t.minutes}m` : '';
  }
  if (field === 'labels' && Array.isArray(value)) {
    return value
      .map((l) => {
        if (l !== null && typeof l === 'object' && 'name' in l) {
          const o = l as { name?: string };
          return o.name ?? '';
        }
        return String(l);
      })
      .filter((s) => s.length > 0)
      .join(', ');
  }
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '';
    }
  }
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  return '';
}
