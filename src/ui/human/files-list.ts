import { renderTable, truncateCell } from '../table.js';
import { type FileItem, type FilesListData } from '../../api/schemas/file.js';

/**
 * Human renderer for `freelo files list` (R26, spec 0038 §3.4).
 *
 * Renders a `cli-table3` table with columns:
 *   - `UUID`    — first 8 chars + `…` (full UUID lives in JSON output)
 *   - `TYPE`    — wire enum (`directory` / `link` / `file` / `document`)
 *   - `NAME`    — truncated to 60 chars; `-` when null/empty (truncating col)
 *   - `PROJECT` — `project.name` or `-`
 *   - `AUTHOR`  — `author.fullname` or numeric id, `-` otherwise
 *   - `DATE`    — `date_add` slice (`YYYY-MM-DD`)
 *   - `SIZE`    — humanized byte count for `file` / `document`; `-` otherwise
 *
 * Async because `renderTable` lazy-loads `cli-table3` (cold-path agents must
 * not pay for it). Mirrors `src/ui/human/reports-list.ts`.
 */
export async function renderFilesListHuman(data: FilesListData): Promise<string> {
  const headers = ['UUID', 'TYPE', 'NAME', 'PROJECT', 'AUTHOR', 'DATE', 'SIZE'];
  if (data.items.length === 0) {
    return renderTable(headers, [['', '', '(no docs or files)', '', '', '', '']], {
      nameColumnIndex: 2,
    });
  }
  const rows = data.items.map((item) => [
    formatUuidPrefix(item.uuid),
    item.type,
    truncateCell(item.name ?? '', 60) || '-',
    formatRefName(item.project),
    formatUserCell(item.author),
    formatDateOnly(item.date_add),
    formatSize(item),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 2, maxNameWidth: 60 });
}

function formatUuidPrefix(uuid: string): string {
  if (uuid.length <= 8) return uuid;
  return `${uuid.slice(0, 8)}…`;
}

function formatRefName(ref: unknown): string {
  if (ref === null || ref === undefined) return '-';
  if (typeof ref !== 'object') return '-';
  const r = ref as { name?: unknown };
  return typeof r.name === 'string' && r.name.length > 0 ? r.name : '-';
}

function formatUserCell(user: FileItem['author']): string {
  if (user === null || user === undefined) return '-';
  if (typeof user !== 'object') return '-';
  const u = user as { id?: unknown; fullname?: unknown };
  if (typeof u.fullname === 'string' && u.fullname.length > 0) return u.fullname;
  if (typeof u.id === 'number') return String(u.id);
  return '-';
}

/** `2026-04-25T10:00:00Z` → `2026-04-25`; `''` / null → `-`. */
function formatDateOnly(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-';
  const tIdx = value.indexOf('T');
  return tIdx > 0 ? value.slice(0, tIdx) : value;
}

/**
 * Size column logic. Renders a humanized byte count for `file` / `document`
 * rows when `size` is present; `-` otherwise. `directory` / `link` rows
 * always render `-` even if a stray `size` is present (the OpenAPI shape
 * documents `size` as type-specific to file/document).
 */
function formatSize(item: FileItem): string {
  if (item.type !== 'file' && item.type !== 'document') return '-';
  const size = item.size;
  if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return '-';
  return humanizeBytes(size);
}

/**
 * Format a non-negative byte count as a human-readable string with one
 * decimal of precision: `<1 KB`, `<1 MB`, `<1 GB`, otherwise `GB`.
 *
 * Exported for unit testing in `test/ui/human/files-list.test.ts` (the
 * boundaries between units are easy to off-by-one). Decimal SI multipliers
 * (1 KB = 1024 B) — matches what most desktop OS file managers display
 * when showing file sizes.
 */
export function humanizeBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
