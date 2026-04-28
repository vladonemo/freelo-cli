/**
 * Human-mode renderer for `freelo time start` (R19, spec 0030).
 *
 * One-line summary in live mode:
 *   `Started timer <uuid> on task #<id> ("<name>" if known) with note "<n>".`
 * Or for taskless work:
 *   `Started timer <uuid> (no task) with note "<n>".`
 *
 * Dry-run renderer is reused from `dryRunEnvelope` consumers — the leaf
 * command branches and hands the dry-run shape here too.
 */

import { type TimeStartLiveData, type TimeStartDryRunData } from '../../api/schemas/time.js';

type RenderableData = TimeStartLiveData | (TimeStartDryRunData & { uuid?: undefined });

export function renderTimeStartHuman(data: RenderableData): string {
  const taskPart = data.task_id !== null ? `task #${data.task_id}` : 'no task';
  const notePart =
    data.note !== null && data.note !== '' ? ` with note "${truncate(data.note, 80)}"` : '';
  if (data.uuid === undefined) {
    // Dry-run path.
    return `[dry-run] Would start timer on ${taskPart}${notePart}.`;
  }
  return `Started timer ${data.uuid} on ${taskPart}${notePart}.`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
