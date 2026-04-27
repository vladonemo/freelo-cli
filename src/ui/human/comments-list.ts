import { renderTable, truncateCell } from '../table.js';
import { type CommentsListData, type CommentFull } from '../../api/schemas/comment.js';

/**
 * Human renderer for `freelo comments list` (R16, spec 0027 §3.4).
 *
 * Renders a `cli-table3` table with columns:
 *   - `id` — numeric comment id, `-` when missing
 *   - `type` — derived from which entity-link block is non-null
 *     (`task` | `document` | `file` | `link` | `?`)
 *   - `project` — `project.name` or `-`
 *   - `task` — `task.name` or `-`
 *   - `author` — `author.fullname` or numeric id
 *   - `date_add` — `YYYY-MM-DD` slice of the wire date-time
 *   - `content` — truncated to 60 chars
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` (mirrors R03 /
 * R04 / R08 patterns; cold path agents must not pay for `cli-table3`).
 */
export async function renderCommentsListHuman(data: CommentsListData): Promise<string> {
  const headers = ['ID', 'TYPE', 'PROJECT', 'TASK', 'AUTHOR', 'DATE_ADD', 'CONTENT'];
  if (data.comments.length === 0) {
    // Single empty row that says "(no comments)" in the type column. Use
    // `nameColumnIndex: 6` so the content column is the truncating one.
    return renderTable(headers, [['', '(no comments)', '', '', '', '', '']], {
      nameColumnIndex: 6,
    });
  }
  const rows = data.comments.map((c) => [
    formatId(c.id),
    formatType(c),
    formatRefName(c.project),
    formatRefName(c.task),
    formatAuthorCell(c.author),
    formatDateOnly(c.date_add),
    truncateCell(c.content ?? '', 60),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 6, maxNameWidth: 60 });
}

function formatId(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatType(c: CommentFull): string {
  if (c.task !== null && c.task !== undefined) return 'task';
  if (c.document !== null && c.document !== undefined) return 'document';
  if (c.file !== null && c.file !== undefined) return 'file';
  if (c.link !== null && c.link !== undefined) return 'link';
  return '?';
}

function formatRefName(ref: unknown): string {
  if (ref === null || ref === undefined) return '-';
  if (typeof ref !== 'object') return '-';
  const r = ref as { name?: unknown };
  return typeof r.name === 'string' && r.name.length > 0 ? r.name : '-';
}

function formatAuthorCell(user: unknown): string {
  if (user === null || user === undefined) return '-';
  if (typeof user !== 'object') return '-';
  const u = user as { id?: unknown; fullname?: unknown };
  if (typeof u.fullname === 'string' && u.fullname.length > 0) return u.fullname;
  if (typeof u.id === 'number') return String(u.id);
  return '-';
}

/**
 * `2026-04-01T10:00:00Z` → `2026-04-01`. Empty / non-string / null → `-`.
 *
 * Mirrors the date-only slicer pattern in `subtasks-list.ts` / `tasks-show.ts`.
 */
function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-';
  const tIdx = value.indexOf('T');
  return tIdx > 0 ? value.slice(0, tIdx) : value;
}
