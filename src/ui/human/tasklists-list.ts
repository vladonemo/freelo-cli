import { renderTable } from '../table.js';
import { type TasklistListData } from '../../api/schemas/tasklist.js';

/**
 * Human renderer for `freelo tasklists list`.
 *
 * Spec 0014 §2.6:
 *  - Default columns: `id, name, project, date_add, state` (same regardless
 *    of `--project` scope — see Open Question #7 resolution).
 *  - Name column truncated at 40 chars (handled by `renderTable`).
 *  - Empty result → header row + `(no tasklists)` body row.
 *  - Project summarised to `project.name`; state summarised to `state.state`.
 *  - No color on values; chalk is reserved for headers/errors elsewhere.
 *
 * `displayFields`, when non-empty, drives the column ordering instead of the
 * default set. Field names follow wire snake_case.
 */
const DEFAULT_COLUMNS: readonly string[] = ['id', 'name', 'project', 'date_add', 'state'];

export async function renderTasklistsListHuman(
  data: TasklistListData,
  opts: { displayFields?: readonly string[] } = {},
): Promise<string> {
  const fields =
    opts.displayFields && opts.displayFields.length > 0 ? opts.displayFields : DEFAULT_COLUMNS;

  const headers = fields.map((f) => f.toUpperCase());
  const nameIdx = fields.indexOf('name');

  if (data.tasklists.length === 0) {
    const empty = fields.map((f) => (f === 'name' ? '(no tasklists)' : ''));
    return renderTable(headers, [empty], {
      ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
    });
  }

  const rows = data.tasklists.map((t) => fields.map((f) => formatCell(t, f)));
  return renderTable(headers, rows, {
    ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
  });
}

/**
 * Format a single field value for human-mode rendering.
 *
 *  - Project summarised to `project.name`.
 *  - State summarised to `state.state` string.
 *  - Currency (`budget`, `real_cost`) summarised as `<amount> <currency>`.
 *  - Everything else stringified.
 */
function formatCell(tasklist: Record<string, unknown>, field: string): string {
  const value = tasklist[field];
  if (value === undefined || value === null) return '';

  if (field === 'project' && typeof value === 'object') {
    const p = value as { name?: string };
    return p.name ?? '';
  }
  if (field === 'state' && typeof value === 'object') {
    const s = value as { state?: string };
    return s.state ?? '';
  }
  if ((field === 'budget' || field === 'real_cost') && typeof value === 'object') {
    const b = value as { amount?: string; currency?: string };
    if (b.amount === undefined || b.currency === undefined) return '';
    return `${b.amount} ${b.currency}`;
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
