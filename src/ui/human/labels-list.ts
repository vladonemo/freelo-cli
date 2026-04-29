import { renderTable, truncateCell } from '../table.js';
import { type LabelsListData } from '../../api/schemas/project-label.js';

/**
 * Human renderer for `freelo labels list` (R23, spec 0035 §3.2).
 *
 * Renders a `cli-table3` table with columns:
 *   - `id` — numeric label id
 *   - `name` — label name (truncated at 40 chars)
 *   - `color` — hex color or `-`
 *   - `private` — `yes` / `no` / `-`
 *   - `usage` — `usage_count` integer or `-`
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` (mirrors the
 * pattern in R03 / R04 / R08 / R16 / R21; cold-path agents must not pay
 * for `cli-table3`).
 */
export async function renderLabelsListHuman(data: LabelsListData): Promise<string> {
  const headers = ['ID', 'NAME', 'COLOR', 'PRIVATE', 'USAGE'];
  if (data.labels.length === 0) {
    return renderTable(headers, [['', '(no labels)', '', '', '']], {
      nameColumnIndex: 1,
    });
  }
  const rows = data.labels.map((l) => [
    formatId(l.id),
    truncateCell(l.name ?? '', 40),
    l.color ?? '-',
    formatBool(l.is_private),
    formatNum(l.usage_count),
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 1, maxNameWidth: 40 });
}

function formatId(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatNum(value: unknown): string {
  return typeof value === 'number' ? String(value) : '-';
}

function formatBool(value: unknown): string {
  if (value === true) return 'yes';
  if (value === false) return 'no';
  return '-';
}
