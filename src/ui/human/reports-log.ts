/**
 * Human-mode renderer for `freelo reports log` (R22, spec 0034).
 *
 * Live:
 *   `Logged 90m on task #4567 (report #7001).`
 *   or `Logged 90m (report #7001, no task).` when general work.
 *
 * Dry-run:
 *   `(dry-run) Would log 90m on task #4567.`
 *
 * Spec 0034 §3.2.
 */

import { type ReportsLogLiveData, type ReportsLogDryRunData } from '../../api/schemas/report.js';

type RenderableData = ReportsLogLiveData | ReportsLogDryRunData;

export function renderReportsLogHuman(data: RenderableData): string {
  if (!('report' in data)) {
    // Dry-run branch — no `report` field (no POST happened).
    const taskPart = `task #${data.applied_input.task_id}`;
    return `(dry-run) Would log ${data.applied_input.minutes}m on ${taskPart}.`;
  }
  const r = data.report;
  const taskPart =
    r.task !== null
      ? `on task #${r.task.id} "${truncate(r.task.name ?? '(unnamed)', 60)}"`
      : 'no task';
  return `Logged ${r.minutes}m ${taskPart} (report #${r.id}).`;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}
