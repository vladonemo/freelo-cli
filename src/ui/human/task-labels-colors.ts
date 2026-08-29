import { renderTable, truncateCell } from '../table.js';
import { type TaskLabelsColorsData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels colors` (M05, spec 0067 §2).
 *
 * Columns:
 *   - `COLOR` — the hex the server accepts. This is the only value that ever
 *     goes over the wire as a label color.
 *   - `PALETTE` — the local `--palette` name for that hex, or `-` when the
 *     server offers a color the CLI has no name for (reach it with `--hex`).
 *   - `DISPLAY NAME` — Freelo's own name for the color. Display only; the API
 *     does not accept it as input (yaml :5968), so it is deliberately NOT the
 *     `PALETTE` column.
 *   - `DEFAULT` — `yes` on the color applied when a label is created without
 *     one.
 *
 * A drift footer is appended only when the local table and the server
 * disagree. Silence means agreement — the common case, and the one a reader
 * should not have to verify by eye. Spec 0067 §6.
 *
 * Async because it lazy-loads `cli-table3` via `renderTable` — cold-path
 * agents must not pay for it (mirrors `task-labels-find.ts`).
 */
export async function renderTaskLabelsColorsHuman(data: TaskLabelsColorsData): Promise<string> {
  const headers = ['COLOR', 'PALETTE', 'DISPLAY NAME', 'DEFAULT'];

  const table =
    data.colors.length === 0
      ? await renderTable(headers, [['', '', '(no colors returned)', '']], {
          nameColumnIndex: 2,
        })
      : await renderTable(
          headers,
          data.colors.map((c) => [
            c.color ?? '-',
            c.palette_name ?? '-',
            truncateCell(c.display_name ?? '', 30),
            c.is_default === true ? 'yes' : '-',
          ]),
          { nameColumnIndex: 2, maxNameWidth: 30 },
        );

  if (data.drift.matches) return table;

  const lines = [table, '', 'Drift: the local --palette table does not match the server.'];
  if (data.drift.server_only.length > 0) {
    lines.push(
      `  Accepted by the server, no --palette name: ${data.drift.server_only.join(', ')}`,
      '    Use --hex <value> to apply one of these.',
    );
  }
  if (data.drift.local_only.length > 0) {
    lines.push(
      `  Offered by --palette, not returned by the server: ${data.drift.local_only.join(', ')}`,
    );
  }
  return lines.join('\n');
}
