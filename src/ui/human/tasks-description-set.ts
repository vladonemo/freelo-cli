import { type TasksDescriptionSetData } from '../../api/schemas/task-description.js';

/**
 * Human renderer for `freelo tasks description set`.
 *
 * Two shapes:
 *
 *   - Live:   `Updated description for task #<id> (<N> bytes from <source>).`
 *   - Dry-run: `(dry-run) Would POST <path> (<N> bytes from <source>).`
 *
 * Sync — no I/O, no lazy imports needed.
 *
 * Spec 0026 §3.3.
 */
export function renderTasksDescriptionSetHuman(data: TasksDescriptionSetData): string {
  if (data.would !== undefined) {
    // Dry-run: source isn't on `data` (it's recorded only on live envelopes
    // per spec §3.3); we surface the byte_length and the wire path.
    return `(dry-run) Would POST ${data.would.path} (${data.byte_length} bytes).`;
  }
  const source = data.source ?? 'unknown';
  return `Updated description for task #${data.task_id} (${data.byte_length} bytes from ${source}).`;
}
