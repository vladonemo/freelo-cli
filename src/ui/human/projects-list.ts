import { renderTable } from '../table.js';
import { type ProjectListData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects list`.
 *
 * Spec 0009 §2.6:
 *  - Default columns vary by `entity_shape`.
 *  - Name column truncated at 40 chars (handled by renderTable).
 *  - Empty result → header row + `(no projects)` body row.
 *  - Tasklists / client summarised: count for tasklists, name for client.
 *  - No color on values; chalk reserved for headers/errors elsewhere.
 *
 * `displayFields`, when non-empty, drives the column ordering instead of
 * the default per-shape set. Field names follow wire snake_case (spec §2.5).
 */
export async function renderProjectsListHuman(
  data: ProjectListData,
  opts: { displayFields?: readonly string[] } = {},
): Promise<string> {
  const fields =
    opts.displayFields && opts.displayFields.length > 0 ? opts.displayFields : defaultColumns(data);

  const headers = fields.map((f) => f.toUpperCase());
  const nameIdx = fields.indexOf('name');

  if (data.projects.length === 0) {
    const empty = fields.map((f) => (f === 'name' ? '(no projects)' : ''));
    return renderTable(headers, [empty], {
      ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
    });
  }

  const rows = data.projects.map((p) => fields.map((f) => formatCell(p, f)));
  return renderTable(headers, rows, {
    ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
  });
}

function defaultColumns(data: ProjectListData): readonly string[] {
  if (data.entity_shape === 'with_tasklists') {
    return ['id', 'name', 'date_add', 'tasklists'];
  }
  return ['id', 'name', 'date_add', 'state'];
}

/**
 * Format a single field value for human-mode rendering.
 *
 * - Tasklists summarised to a count.
 * - Client summarised to its `name` (or `email`).
 * - State summarised to its `state` string.
 * - Currency summarised as `<amount> <currency>`.
 * - Owner summarised to `fullname`.
 * - Everything else stringified.
 */
function formatCell(project: Record<string, unknown>, field: string): string {
  const value = project[field];
  if (value === undefined || value === null) return '';

  if (field === 'tasklists' && Array.isArray(value)) {
    return String(value.length);
  }
  if (field === 'client' && typeof value === 'object') {
    const c = value as { name?: string; email?: string };
    return c.name ?? c.email ?? '';
  }
  if (field === 'state' && typeof value === 'object') {
    const s = value as { state?: string };
    return s.state ?? '';
  }
  if (field === 'owner' && typeof value === 'object') {
    const o = value as { fullname?: string };
    return o.fullname ?? '';
  }
  if ((field === 'budget' || field === 'real_cost') && typeof value === 'object') {
    const b = value as { amount?: string; currency?: string };
    if (b.amount === undefined || b.currency === undefined) return '';
    return `${b.amount} ${b.currency}`;
  }
  if (typeof value === 'object') {
    // Unknown nested shape — stringify compactly.
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
