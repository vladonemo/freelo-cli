import { type TaskchecksEditData } from '../../api/schemas/taskcheck.js';

/**
 * Human renderer for `freelo taskchecks edit` (M03, spec 0066).
 *
 * Two shapes, gated on `data.would`:
 *   - Live:    `Edited taskcheck 4821 (name, worker).`
 *   - Dry-run: `(dry-run) Would edit taskcheck 4821 (name, worker).`
 *
 * The parenthesised list is `applied_changes` — what the CLI *sent*, not what
 * the server confirmed. `POST /taskcheck/{id}` returns a bare `SuccessResponse`
 * with no entity (yaml :2149-2155), so there is nothing server-derived to
 * report; a 200 means the whole body was accepted.
 */
export function renderTaskchecksEditHuman(data: TaskchecksEditData): string {
  const changes = data.applied_changes.map(labelFor).join(', ');
  const suffix = changes.length > 0 ? ` (${changes})` : '';
  if (data.would !== undefined) {
    return `(dry-run) Would edit taskcheck ${data.taskcheck_id}${suffix}.`;
  }
  return `Edited taskcheck ${data.taskcheck_id}${suffix}.`;
}

function labelFor(change: TaskchecksEditData['applied_changes'][number]): string {
  return change === 'clear_worker' ? 'cleared worker' : change;
}
