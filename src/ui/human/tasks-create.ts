import { type TasksCreateData } from '../../api/schemas/task.js';

/**
 * Human renderer for `freelo tasks create` (R09 + spec 0041 label-fix).
 *
 * Three shapes:
 *   - Live success: `Created task #ID (NAME) in tasklist TID (project PID).`
 *     plus an "Attached labels: …" line when `applied_labels.attached` is
 *     non-empty, or "Attempted labels: … (failed)" when the attach failed.
 *   - Dry-run: `(dry-run) Would create task in tasklist TID (project PID).`
 *     plus "+ attach labels: …" when the requested labels would have been
 *     attached after the create call (spec 0041 §4.3).
 *   - Live success in batch (called per-line via NDJSON path) — same shape;
 *     the streamer flushes per line.
 *
 * The envelope's `notice` field is appended by the caller (e.g.
 * `writeEnvelope`) on a separate line — this renderer takes data only.
 *
 * Spec 0019 §3.6 + spec 0041 §6.4.
 */
export function renderTasksCreateHuman(data: TasksCreateData): string {
  const projectPart = data.project_id === null ? 'project ?' : `project ${data.project_id}`;
  const lines: string[] = [];

  if (data.would !== undefined) {
    lines.push(`(dry-run) Would create task in tasklist ${data.tasklist_id} (${projectPart}).`);
    // Second `would` entry, if present, is the label-attach call.
    if (data.would.length > 1) {
      const attachBody = data.would[1]?.body as { labels?: Array<{ name: string }> } | undefined;
      const names = attachBody?.labels?.map((l) => l.name) ?? [];
      if (names.length > 0) {
        lines.push(`  + attach labels: ${names.join(', ')}`);
      }
    }
    return lines.join('\n');
  }

  if (data.task !== undefined) {
    lines.push(
      `Created task #${data.task.id} (${data.task.name}) in tasklist ${data.tasklist_id} (${projectPart}).`,
    );
    if (data.applied_labels !== undefined) {
      if (data.applied_labels.attached.length > 0) {
        lines.push(`Attached labels: ${data.applied_labels.attached.join(', ')}`);
      } else if (data.applied_labels.failed.length > 0) {
        const names = data.applied_labels.requested.join(', ');
        lines.push(`Attempted labels: ${names} (attach failed)`);
      }
    }
    return lines.join('\n');
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
