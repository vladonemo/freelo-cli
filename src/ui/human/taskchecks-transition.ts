import { type TaskchecksTransitionData } from '../../api/schemas/taskcheck.js';

/**
 * Human renderer for `freelo taskchecks finish` / `freelo taskchecks reopen`
 * (M03, spec 0066).
 *
 *   - Live:    `Finished taskcheck 4821.` / `Reopened taskcheck 4821.`
 *   - Dry-run: `(dry-run) Would finish taskcheck 4821.`
 *
 * There is deliberately **no** "was already finished / already active" shape.
 * Unlike R11's `tasks finish`, this resource has no read endpoint
 * (`GET /taskcheck/{id}` does not exist), so the CLI cannot observe prior state
 * and never claims to — spec 0066 §5.2 / decision 5. A branch for it would be
 * unreachable.
 */
export function renderTaskchecksTransitionHuman(data: TaskchecksTransitionData): string {
  const id = data.taskcheck_id;
  if (data.would !== undefined) {
    return `(dry-run) Would ${data.verb} taskcheck ${id}.`;
  }
  return `${data.verb === 'finish' ? 'Finished' : 'Reopened'} taskcheck ${id}.`;
}

/**
 * Per-item failure line for multi-id batch runs in human mode. Mirrors
 * `renderBatchItemFailureHuman` in `src/ui/human/tasks-transition.ts`.
 */
export function renderTaskchecksBatchFailureHuman(
  index: number,
  idMaybe: number | null,
  message: string,
): string {
  const idPart = idMaybe === null ? '' : ` (${idMaybe})`;
  return `Failed item ${index + 1}${idPart}: ${message}`;
}
