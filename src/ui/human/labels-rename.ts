/**
 * Human-mode renderer for `freelo labels rename` (R23, spec 0035).
 *
 * Live:
 *   `Renamed label #12 (name="Billable", color="#9b59b6").`
 *
 * Dry-run:
 *   `(dry-run) Would rename label #12 (name="Billable").`
 *
 * Spec 0035 §5.2.
 */

import {
  type LabelsRenameLiveData,
  type LabelsRenameDryRunData,
} from '../../api/schemas/project-label.js';

type RenderableData = LabelsRenameLiveData | (LabelsRenameDryRunData & { would?: unknown });

export function renderLabelsRenameHuman(data: RenderableData): string {
  const parts = formatChanges(data.applied_changes);
  const dryRun = 'would' in data && data.would !== undefined;
  if (dryRun) {
    return `(dry-run) Would rename label #${data.label_id} (${parts}).`;
  }
  return `Renamed label #${data.label_id} (${parts}).`;
}

function formatChanges(c: LabelsRenameLiveData['applied_changes']): string {
  const out: string[] = [];
  if (c.name !== undefined) out.push(`name=${JSON.stringify(c.name)}`);
  if (c.color !== undefined) out.push(`color=${JSON.stringify(c.color)}`);
  if (c.is_private !== undefined) out.push(`is_private=${c.is_private}`);
  return out.length > 0 ? out.join(', ') : '(no changes)';
}
