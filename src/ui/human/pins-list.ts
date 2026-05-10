import { renderTable, truncateCell } from '../table.js';
import { type PinsListData } from '../../api/schemas/pin.js';

/**
 * Human renderer for `freelo pins list` (R44, spec 0058).
 *
 * Renders a `cli-table3` table with columns:
 *   - `id`    — numeric pin id
 *   - `title` — display title (truncated at 40 chars), `-` if absent
 *   - `link`  — full URL, `-` if absent
 *
 * Empty:
 *   `Project #<id> — no pinned items.`
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` (mirrors the
 * pattern in R03 / R04 / R23 / R28; cold-path agents must not pay for
 * `cli-table3`).
 */
export async function renderPinsListHuman(data: PinsListData): Promise<string> {
  if (data.pins.length === 0) {
    return `Project #${data.project_id} — no pinned items.`;
  }
  const headers = ['ID', 'TITLE', 'LINK'];
  const rows = data.pins.map((p) => [
    String(p.id),
    truncateCell(p.title ?? '-', 40),
    p.link ?? '-',
  ]);
  return renderTable(headers, rows, { nameColumnIndex: 1, maxNameWidth: 40 });
}
