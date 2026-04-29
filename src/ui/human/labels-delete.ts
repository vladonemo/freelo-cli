import { type LabelsDeleteData } from '../../api/schemas/project-label.js';

/**
 * Human renderer for `freelo labels delete` (R23, spec 0035).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:    `Deleted label #ID.`
 *   - Already deleted: `Label #ID was already deleted.`
 *   - Dry-run (would): `(dry-run) Would delete label #ID.`
 *
 * Mirrors `renderReportsDeleteHuman` byte-for-byte modulo the noun.
 *
 * Spec 0035 §3.4.
 */
export function renderLabelsDeleteHuman(data: LabelsDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete label #${data.label_id}.`;
  }
  if (data.already_in_target_state) {
    return `Label #${data.label_id} was already deleted.`;
  }
  return `Deleted label #${data.label_id}.`;
}
