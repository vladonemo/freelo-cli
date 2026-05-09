import { renderTable } from '../table.js';
import {
  type ProjectsWorkersListData,
  type ProjectsWorkersRemoveData,
} from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects workers list`.
 *
 * Spec 0045 §3.5. Renders an ID / FULLNAME table; empty result prints the
 * canonical `(no workers)` row mirroring `projects show --with workers`'s
 * empty path.
 *
 * `displayFields`, when non-empty, drives the column ordering. Allowed values
 * are `'id'` and `'fullname'` (the entire wire schema, decision 8).
 */
export async function renderProjectsWorkersListHuman(
  data: ProjectsWorkersListData,
  opts: { displayFields?: readonly ('id' | 'fullname')[] } = {},
): Promise<string> {
  const fields: readonly ('id' | 'fullname')[] =
    opts.displayFields && opts.displayFields.length > 0 ? opts.displayFields : ['id', 'fullname'];

  const headers = fields.map((f) => f.toUpperCase());
  const nameIdx = fields.indexOf('fullname');

  if (data.workers.length === 0) {
    const empty = fields.map((f) => (f === 'fullname' ? '(no workers)' : ''));
    return renderTable(headers, [empty], {
      ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
    });
  }

  const rows = data.workers.map((w) =>
    fields.map((f) => {
      if (f === 'id') return String(w.id);
      // 'fullname'
      return w.fullname ?? '';
    }),
  );
  return renderTable(headers, rows, {
    ...(nameIdx >= 0 ? { nameColumnIndex: nameIdx } : {}),
  });
}

/**
 * Human renderer for `freelo projects workers remove`.
 *
 * Spec 0045 §3.5. Single line — live success vs. dry-run. The kind label
 * (`by ids` / `by emails`) is derived from the discriminant `removed_by`.
 */
export function renderProjectsWorkersRemoveHuman(data: ProjectsWorkersRemoveData): string {
  const subject = data.count === 1 ? '1 worker' : `${data.count} workers`;
  const kind = data.removed_by === 'ids' ? 'by ids' : 'by emails';
  if (data.would !== undefined) {
    return `(dry-run) Would remove ${subject} from project #${data.project_id} (${kind}).`;
  }
  return `Removed ${subject} from project #${data.project_id} (${kind}).`;
}
