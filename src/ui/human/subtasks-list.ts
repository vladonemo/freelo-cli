import { renderTable } from '../table.js';
import { type SubtasksListData } from '../../api/schemas/subtask.js';

/**
 * Human renderer for `freelo subtasks list`.
 *
 * Renders a `cli-table3` table with columns:
 *   - `id` — numeric subtask id
 *   - `name` — subtask title (truncated at the standard 40 chars)
 *   - `worker` — worker fullname (or numeric id), `-` when unassigned
 *   - `due_date` — YYYY-MM-DD slice of the wire date-time, `-` when null
 *   - `state` — `state.state` string (e.g. `active`), `-` when null
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` (mirrors R03 /
 * R04 / R08 patterns; cold path agents must not pay for `cli-table3`).
 *
 * Spec 0025 §3.2.
 */
export async function renderSubtasksListHuman(data: SubtasksListData): Promise<string> {
  const headers = ['ID', 'NAME', 'WORKER', 'DUE_DATE', 'STATE'];
  if (data.subtasks.length === 0) {
    // Single empty row that says "(no subtasks)" in the name column. Mirrors
    // `projects-list.ts` empty-state convention.
    return renderTable(headers, [['', '(no subtasks)', '', '', '']], { nameColumnIndex: 1 });
  }
  const rows = data.subtasks.map((s) => [
    formatId(s.id),
    typeof s.name === 'string' && s.name.length > 0 ? s.name : '',
    formatUserCell(s.worker),
    formatDateOnly(s.due_date),
    formatStateCell(s.state),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 1 });
}

function formatId(value: unknown): string {
  return typeof value === 'number' ? String(value) : '';
}

function formatUserCell(user: unknown): string {
  if (user === null || user === undefined) return '-';
  if (typeof user !== 'object') return '-';
  const u = user as { id?: unknown; fullname?: unknown };
  if (typeof u.fullname === 'string' && u.fullname.length > 0) return u.fullname;
  if (typeof u.id === 'number') return String(u.id);
  return '-';
}

function formatStateCell(state: unknown): string {
  if (state === null || state === undefined) return '-';
  if (typeof state !== 'object') return '-';
  const s = state as { state?: unknown };
  return typeof s.state === 'string' ? s.state : '-';
}

/**
 * `2026-05-01T00:00:00Z` → `2026-05-01`. Empty / non-string / null → `-`.
 *
 * Mirrors the date-only slicer pattern in `tasks-show.ts`.
 */
function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-';
  const tIdx = value.indexOf('T');
  return tIdx > 0 ? value.slice(0, tIdx) : value;
}
