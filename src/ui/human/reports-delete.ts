import { type ReportsDeleteData } from '../../api/schemas/report.js';

/**
 * Human renderer for `freelo reports delete` (R22, spec 0034).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:      `Deleted report #ID.`
 *   - Already deleted:   `Report #ID was already deleted.`
 *   - Dry-run (would):   `(dry-run) Would delete report #ID.`
 *
 * Mirrors `renderTasksDeleteHuman` byte-for-byte modulo the noun.
 *
 * Spec 0034 §3.4.
 */
export function renderReportsDeleteHuman(data: ReportsDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete report #${data.report_id}.`;
  }
  if (data.already_in_target_state) {
    return `Report #${data.report_id} was already deleted.`;
  }
  return `Deleted report #${data.report_id}.`;
}
