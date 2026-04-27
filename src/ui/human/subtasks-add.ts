import { type SubtasksAddData } from '../../api/schemas/subtask.js';

/**
 * Human renderer for `freelo subtasks add` (single envelope).
 *
 * Three shapes:
 *   - **Live smart**: `Created subtask #N "title".`
 *   - **Live simple (with discarded inputs)**:
 *     `Created simple taskcheck #N "title". Note: server fell back to a
 *      simple taskcheck; ignored: worker, due.`
 *   - **Live simple (no discarded inputs)**:
 *     `Created simple taskcheck #N "title". (server fell back to a simple
 *      taskcheck; no rich inputs to discard.)`
 *   - **Dry-run**: `(dry-run) Would POST /task/<task_id>/subtasks (name="<n>").`
 *
 * Sync — no I/O, no lazy imports needed.
 *
 * Spec 0025 §3.3.
 */
export function renderSubtasksAddHuman(data: SubtasksAddData): string {
  // Dry-run: surface the would-be call. data.subtask / data.storage_form
  // are not present in dry-run envelopes (spec §4.2 / decision 16).
  if (data.would !== undefined) {
    const body = data.would.body as { name?: unknown };
    const name = typeof body?.name === 'string' ? body.name : '';
    return `(dry-run) Would POST ${data.would.path} (name="${name}").`;
  }

  // Live: data.subtask and data.storage_form are always present here.
  const subtask = data.subtask as { id?: unknown; name?: unknown } | undefined;
  const id = subtask && typeof subtask.id === 'number' ? subtask.id : '?';
  const name = subtask && typeof subtask.name === 'string' ? subtask.name : '';
  const nameClause = name.length > 0 ? ` "${name}"` : '';

  if (data.storage_form === 'smart') {
    return `Created subtask #${id}${nameClause}.`;
  }

  // simple-taskcheck path
  if (data.input_ignored !== undefined && data.input_ignored.length > 0) {
    return `Created simple taskcheck #${id}${nameClause}. Note: server fell back to a simple taskcheck; ignored: ${data.input_ignored.join(', ')}.`;
  }
  return `Created simple taskcheck #${id}${nameClause}. (Server fell back to a simple taskcheck; no rich inputs to discard.)`;
}

/**
 * Per-line success renderer for `--stdin` batch mode. Same shape as
 * `renderSubtasksAddHuman` but prefixed with the line index for human
 * scanning.
 *
 * Mirrors R09's `renderBatchLineSuccessHuman`.
 */
export function renderSubtasksAddBatchLineSuccessHuman(data: SubtasksAddData): string {
  const idx = data.line_index ?? 0;
  return `[line ${idx + 1}] ${renderSubtasksAddHuman(data)}`;
}

/**
 * Per-line failure renderer for `--stdin` batch mode. Mirrors R09's
 * `renderBatchLineFailureHuman`.
 */
export function renderSubtasksAddBatchLineFailureHuman(lineIndex: number, message: string): string {
  return `[line ${lineIndex + 1}] failed: ${message}`;
}
