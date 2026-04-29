import { renderTable, truncateCell } from '../table.js';
import { type Notification, type NotificationsListData } from '../../api/schemas/notification.js';

/**
 * Human renderer for `freelo notifications list` (R28, spec 0040 §3.5.1).
 *
 * Renders a `cli-table3` table with columns:
 *   - `ID`        — numeric notification id
 *   - `TYPE`      — wire type string (`task_assigned`, etc.)
 *   - `UNREAD`    — `*` when `is_unread`, blank otherwise
 *   - `PROJECT`   — `project.name` or `-`
 *   - `TASK`      — `task.name` (truncated) or `tasklist.name`, `-` otherwise
 *   - `AUTHOR`    — `author.fullname` or numeric id, `-` otherwise
 *   - `DATE`      — `date_action` slice (`YYYY-MM-DD`)
 *
 * Async because `renderTable` lazy-loads `cli-table3` (cold-path agents must
 * not pay for it). Mirrors `src/ui/human/files-list.ts`.
 */
export async function renderNotificationsListHuman(data: NotificationsListData): Promise<string> {
  const headers = ['ID', 'TYPE', 'UNREAD', 'PROJECT', 'TASK', 'AUTHOR', 'DATE'];
  if (data.items.length === 0) {
    return renderTable(headers, [['', '', '', '', '(no notifications)', '', '']], {
      nameColumnIndex: 4,
    });
  }
  const rows = data.items.map((item) => [
    String(item.id),
    item.type ?? '-',
    item.is_unread === true ? '*' : '',
    formatRefName(item.project),
    formatTaskOrTasklist(item),
    formatAuthor(item.author),
    formatDateOnly(item.date_action),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 4, maxNameWidth: 60 });
}

function formatRefName(ref: unknown): string {
  if (ref === null || ref === undefined) return '-';
  if (typeof ref !== 'object') return '-';
  const r = ref as { name?: unknown };
  return typeof r.name === 'string' && r.name.length > 0 ? r.name : '-';
}

function formatTaskOrTasklist(item: Notification): string {
  // Prefer task.name over tasklist.name when both present (events are
  // task-scoped most of the time). Truncate to 60 chars.
  const taskName =
    item.task !== null && typeof item.task === 'object'
      ? (item.task as { name?: unknown }).name
      : undefined;
  if (typeof taskName === 'string' && taskName.length > 0) {
    return truncateCell(taskName, 60);
  }
  const tasklistName =
    item.tasklist !== null && typeof item.tasklist === 'object'
      ? (item.tasklist as { name?: unknown }).name
      : undefined;
  if (typeof tasklistName === 'string' && tasklistName.length > 0) {
    return truncateCell(tasklistName, 60);
  }
  return '-';
}

function formatAuthor(author: Notification['author']): string {
  if (author === null || author === undefined) return '-';
  if (typeof author !== 'object') return '-';
  const a = author as { id?: unknown; fullname?: unknown };
  if (typeof a.fullname === 'string' && a.fullname.length > 0) return a.fullname;
  if (typeof a.id === 'number') return String(a.id);
  return '-';
}

/** `2026-04-25T10:00:00Z` → `2026-04-25`; null / empty / non-string → `-`. */
function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-';
  const tIdx = value.indexOf('T');
  return tIdx > 0 ? value.slice(0, tIdx) : value;
}
