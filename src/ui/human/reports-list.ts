import { renderTable, truncateCell } from '../table.js';
import { type ReportsListData, type WorkReportFull } from '../../api/schemas/report.js';

/**
 * Human renderer for `freelo reports list` (R21, spec 0033 §3.4).
 *
 * Renders a `cli-table3` table with columns:
 *   - `id` — numeric report id, `-` when missing
 *   - `date` — `date_reported` slice (`YYYY-MM-DD`)
 *   - `worker` — `worker.fullname` or numeric id
 *   - `project` — `project.name` or `-`
 *   - `task` — `task.name` or `-`
 *   - `minutes` — integer; the unit of work logged
 *   - `note` — truncated to 60 chars
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` (mirrors the
 * pattern in R03 / R04 / R08 / R16; cold-path agents must not pay for
 * `cli-table3`).
 */
export async function renderReportsListHuman(data: ReportsListData): Promise<string> {
  const headers = ['ID', 'DATE', 'WORKER', 'PROJECT', 'TASK', 'MINUTES', 'NOTE'];
  if (data.reports.length === 0) {
    // Single empty row in the type-equivalent column. `nameColumnIndex: 6`
    // makes NOTE the truncating column on the empty fallback too.
    return renderTable(headers, [['', '(no work reports)', '', '', '', '', '']], {
      nameColumnIndex: 6,
    });
  }
  const rows = data.reports.map((r) => [
    formatId(r.id),
    formatDateOnly(r.date_reported),
    formatUserCell(r.worker),
    formatRefName(r.project),
    formatRefName(r.task),
    formatMinutes(r.minutes),
    truncateCell(r.note ?? '', 60),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 6, maxNameWidth: 60 });
}

function formatId(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatMinutes(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatRefName(ref: unknown): string {
  if (ref === null || ref === undefined) return '-';
  if (typeof ref !== 'object') return '-';
  const r = ref as { name?: unknown };
  return typeof r.name === 'string' && r.name.length > 0 ? r.name : '-';
}

function formatUserCell(user: WorkReportFull['worker']): string {
  if (user === null || user === undefined) return '-';
  if (typeof user !== 'object') return '-';
  const u = user as { id?: unknown; fullname?: unknown };
  if (typeof u.fullname === 'string' && u.fullname.length > 0) return u.fullname;
  if (typeof u.id === 'number') return String(u.id);
  return '-';
}

/**
 * `2026-04-25` passes through; `2026-04-25T10:00:00Z` → `2026-04-25`. Empty
 * / non-string / null → `-`. Mirrors the date-only slicer pattern in
 * `subtasks-list.ts` / `comments-list.ts`.
 */
function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-';
  const tIdx = value.indexOf('T');
  return tIdx > 0 ? value.slice(0, tIdx) : value;
}
