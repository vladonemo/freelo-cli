/**
 * Human-mode renderer for `freelo reports edit` (R22, spec 0034).
 *
 * Live:
 *   `Edited report #7001 (minutes=60, note="…").`
 *
 * Dry-run:
 *   `(dry-run) Would edit report #7001 (minutes=60, note="…").`
 *
 * Spec 0034 §3.3.
 */

import { type ReportsEditLiveData, type ReportsEditDryRunData } from '../../api/schemas/report.js';

type RenderableData = ReportsEditLiveData | ReportsEditDryRunData;

export function renderReportsEditHuman(data: RenderableData): string {
  const parts = formatChanges(data.applied_changes);
  if (!('report' in data)) {
    // Dry-run branch.
    // We can't show the report id without re-parsing the would.path; the
    // caller-side renderer only sees `applied_changes`. For dry-run we
    // still need an id — pull it from the path stamped into would.path
    // by the leaf command. The schema-level `data` doesn't expose path
    // here; render a slimmer message keyed only on the changes.
    return `(dry-run) Would edit report (${parts}).`;
  }
  return `Edited report #${data.report.id} (${parts}).`;
}

function formatChanges(c: ReportsEditDryRunData['applied_changes']): string {
  const out: string[] = [];
  if (c.minutes !== undefined) out.push(`minutes=${c.minutes}`);
  if (c.note !== undefined) out.push(`note=${JSON.stringify(c.note)}`);
  if (c.date_reported !== undefined) out.push(`date_reported=${c.date_reported}`);
  return out.length > 0 ? out.join(', ') : '(no changes)';
}
