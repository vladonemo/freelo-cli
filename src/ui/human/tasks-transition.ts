import { type TasksTransitionData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks finish` and `freelo tasks reopen` (R11).
 *
 * Four shapes, gated on `data.would`, `data.already_in_target_state`, and
 * `data.verb`:
 *   - Live success:        `Finished task #ID (was active).` /
 *                          `Reopened task #ID (was finished).`
 *   - Already in target:   `Task #ID was already finished.` /
 *                          `Task #ID was already active.`
 *   - Dry-run (would):     `(dry-run) Would finish task #ID (currently active).` /
 *                          `(dry-run) Would reopen task #ID (currently finished).`
 *   - Dry-run skipped:     `(dry-run) Task #ID is already finished — would skip.`
 *                          (already-in-target + dry-run; no `would` in envelope)
 *
 * Spec 0021 §3.2 / §3.7.
 */
export function renderTasksTransitionHuman(data: TasksTransitionData): string {
  const verbPast = data.verb === 'finish' ? 'Finished' : 'Reopened';
  const verbInf = data.verb === 'finish' ? 'finish' : 'reopen';
  const targetAdj = data.verb === 'finish' ? 'finished' : 'active';

  if (data.would !== undefined) {
    // Dry-run AND a POST would have run.
    return `(dry-run) Would ${verbInf} task #${data.task_id} (currently ${data.previous_state}).`;
  }

  if (data.already_in_target_state) {
    // No POST happened. Could be live (skipped) or dry-run with skip.
    const live = `Task #${data.task_id} was already ${targetAdj}.`;
    // We cannot tell live vs. dry-run from `data` alone — the renderer is
    // called only after the envelope is built, and dry-run is signaled at
    // the envelope level. The caller-side distinguishes; for the renderer,
    // both flow into the same human line — agents read the structured
    // envelope for the `dry_run` discriminant.
    return live;
  }

  // Live success (POST happened).
  return `${verbPast} task #${data.task_id} (was ${data.previous_state}).`;
}

/**
 * Render an error envelope for a single batch line/id in `human` mode.
 * Format: `Failed item N (id=ID): <message>`. `inputIndex` is 0-indexed; the
 * displayed number is 1-indexed for human eyes.
 */
export function renderBatchItemFailureHuman(
  inputIndex: number,
  taskId: number | null,
  message: string,
): string {
  const idPart = taskId === null ? '' : ` (id=${taskId})`;
  return `Failed item ${inputIndex + 1}${idPart}: ${message}`;
}
