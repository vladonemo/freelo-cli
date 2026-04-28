/**
 * Human-mode renderer for `freelo time stop` (R20, spec 0032).
 *
 * Live:
 *   `Stopped timer #<id> (<minutes>m on task #<task.id> "<task.name>")`
 *   or `(<minutes>m, no task)` when general work.
 *
 * Dry-run:
 *   `[dry-run] Would stop the active timer.`
 */

import { type TimeStopLiveData, type TimeStopDryRunData } from '../../api/schemas/time.js';

type RenderableData = TimeStopLiveData | TimeStopDryRunData;

export function renderTimeStopHuman(data: RenderableData): string {
  if (!('work_report' in data)) {
    return '[dry-run] Would stop the active timer.';
  }
  const wr = data.work_report;
  const taskPart =
    wr.task !== null
      ? `on task #${wr.task.id} "${truncate(wr.task.name ?? '(unnamed)', 60)}"`
      : 'no task';
  return `Stopped timer #${wr.id} (${wr.minutes}m, ${taskPart}).`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
