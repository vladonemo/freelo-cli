import { type LabelsAttachData } from '../../api/schemas/project-label.js';

/**
 * Human renderer for `freelo labels attach` (R23, spec 0035 §3.5).
 *
 * Live: `Attached "Billable" to project #7.`
 * Dry-run: `(dry-run) Would attach "Billable" to project #7.`
 *
 * Spec 0035 §5.4.
 */
export function renderLabelsAttachHuman(data: LabelsAttachData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would attach ${JSON.stringify(data.name)} to project #${data.project_id}.`;
  }
  return `Attached ${JSON.stringify(data.name)} to project #${data.project_id}.`;
}
