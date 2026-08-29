import { type TaskchecksDeleteData } from '../../api/schemas/taskcheck.js';

/**
 * Human renderer for `freelo taskchecks delete` (M03, spec 0066).
 *
 *   - Live:    `Deleted taskcheck 4821.`
 *   - Dry-run: `(dry-run) Would delete taskcheck 4821.`
 *
 * There is deliberately **no** "was already deleted" shape. This command never
 * absorbs a 404 into an idempotent success (spec 0066 §5.1 / decision 4): the
 * one 404 the API documents here means "you passed a *smart* taskcheck id",
 * i.e. the item is untouched and reachable via `freelo tasks delete`. Reporting
 * that as already-deleted would be a plain untruth. A third branch would be
 * dead code and a permanent coverage hole (calibration §4).
 */
export function renderTaskchecksDeleteHuman(data: TaskchecksDeleteData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would delete taskcheck ${data.taskcheck_id}.`;
  }
  return `Deleted taskcheck ${data.taskcheck_id}.`;
}
