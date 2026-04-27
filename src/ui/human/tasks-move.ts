import { type TasksMoveData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks move` (R12, spec 0022).
 *
 * Four shapes, gated on `data.would` and `data.already_in_target_tasklist`:
 *   - Live success:        `Moved task #ID from tasklist #FROM to tasklist #TO.`
 *                          (project change, if any, surfaced as ` (project #FROM_P → #TO_P)`)
 *   - Already in target:   `Task #ID was already in tasklist #TO.`
 *   - Dry-run (would):     `(dry-run) Would move task #ID from tasklist #FROM to tasklist #TO.`
 *   - Dry-run skipped:     `(dry-run) Task #ID is already in tasklist #TO — would skip.`
 *                          (already-in-target + dry-run; no `would` in envelope)
 *
 * Spec 0022 §3.2 / §3.6.
 */
export function renderTasksMoveHuman(data: TasksMoveData): string {
  const fromTasklist = data.from_tasklist_id;
  const toTasklist = data.to_tasklist_id;

  if (data.would !== undefined) {
    // Dry-run AND a POST would have run.
    const fromPart = fromTasklist === null ? 'unknown tasklist' : `tasklist #${fromTasklist}`;
    return `(dry-run) Would move task #${data.task_id} from ${fromPart} to tasklist #${toTasklist}.`;
  }

  if (data.already_in_target_tasklist) {
    // No POST happened. Could be live (skipped) or dry-run with skip.
    return `Task #${data.task_id} was already in tasklist #${toTasklist}.`;
  }

  // Live success (POST happened).
  const fromPart = fromTasklist === null ? 'unknown tasklist' : `tasklist #${fromTasklist}`;
  const projectChange =
    data.from_project_id !== null &&
    data.to_project_id !== null &&
    data.from_project_id !== data.to_project_id
      ? ` (project #${data.from_project_id} → #${data.to_project_id})`
      : '';
  return `Moved task #${data.task_id} from ${fromPart} to tasklist #${toTasklist}${projectChange}.`;
}
