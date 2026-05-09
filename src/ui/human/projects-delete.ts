import { type ProjectsDeleteData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects delete` (R30, spec 0043).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:        `Deleted project #ID.`
 *   - Already deleted:     `Project #ID was already deleted.`
 *   - Dry-run (would):     `(dry-run) Would delete project #ID.`
 *
 * Mirrors `renderTasksDeleteHuman` (R13). Spec 0043 §3.6.
 */
export function renderProjectsDeleteHuman(data: ProjectsDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete project #${data.project_id}.`;
  }
  if (data.already_in_target_state) {
    return `Project #${data.project_id} was already deleted.`;
  }
  return `Deleted project #${data.project_id}.`;
}
