import { type LabelsDetachData } from '../../api/schemas/project-label.js';

/**
 * Human renderer for `freelo labels detach` (R23, spec 0035 §3.6).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:        `Detached label #12 from project #7.`
 *   - Already detached:    `Label #12 was not attached to project #7.`
 *   - Dry-run:             `(dry-run) Would detach label #12 from project #7.`
 *
 * Spec 0035 §5.5.
 */
export function renderLabelsDetachHuman(data: LabelsDetachData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would detach label #${data.label_id} from project #${data.project_id}.`;
  }
  if (data.already_in_target_state) {
    return `Label #${data.label_id} was not attached to project #${data.project_id}.`;
  }
  return `Detached label #${data.label_id} from project #${data.project_id}.`;
}
