import { type TasksCreateData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks create` (R09).
 *
 * Three shapes:
 *   - Live success: `Created task #ID (NAME) in tasklist TID (project PID).`
 *   - Dry-run:      `(dry-run) Would create task in tasklist TID (project PID).`
 *   - Live success in batch (called per-line via NDJSON path — but the human
 *     mode in batch is line-by-line via this same renderer; it doesn't try to
 *     render a "summary" because the streamer flushes per line).
 *
 * Spec 0019 §3.6.
 */
export function renderTasksCreateHuman(data: TasksCreateData): string {
  const projectPart = data.project_id === null ? 'project ?' : `project ${data.project_id}`;
  if (data.would !== undefined) {
    return `(dry-run) Would create task in tasklist ${data.tasklist_id} (${projectPart}).`;
  }
  if (data.task !== undefined) {
    return `Created task #${data.task.id} (${data.task.name}) in tasklist ${data.tasklist_id} (${projectPart}).`;
  }
  return `Tasks create envelope (tasklist ${data.tasklist_id}, ${projectPart}).`;
}

/**
 * Render an error envelope for a single batch line. Used in `human` output
 * mode when a per-line failure occurs in `--stdin` batch mode.
 *
 * Format: `Failed line N: <message>` (1-indexed line number for human eyes;
 * the structured envelope uses 0-indexed `line_index`).
 */
export function renderBatchLineFailureHuman(lineIndex: number, message: string): string {
  return `Failed line ${lineIndex + 1}: ${message}`;
}

/**
 * Render a successful batch line in `human` mode.
 */
export function renderBatchLineSuccessHuman(data: TasksCreateData): string {
  return renderTasksCreateHuman(data);
}
