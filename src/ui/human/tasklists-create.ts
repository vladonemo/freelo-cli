import { type TasklistsCreateData } from '../../api/schemas/tasklist.js';

/**
 * Human renderer for `freelo tasklists create` (R34, spec 0047).
 *
 * Two shapes:
 *   - Live success: `Created tasklist #ID (NAME) in project #PID.`
 *   - Dry-run: `(dry-run) Would create tasklist "NAME" in project #PID.`
 *     plus an indented `+ budget: <str>` line when `--budget` was set.
 *
 * The envelope's `notice` field, if any, is appended by the caller on a
 * separate line — this renderer takes data only.
 *
 * Spec 0047 §3.1.
 */
export function renderTasklistsCreateHuman(data: TasklistsCreateData): string {
  if (data.would !== undefined) {
    const { name, budget } = data.would.body;
    const lines: string[] = [
      `(dry-run) Would create tasklist "${name}" in project #${data.project_id}.`,
    ];
    if (budget !== undefined) lines.push(`  + budget: ${budget}`);
    return lines.join('\n');
  }

  if (data.tasklist !== undefined) {
    return `Created tasklist #${data.tasklist.id} (${data.tasklist.name}) in project #${data.project_id}.`;
  }

  // Defensive — neither branch matched. Should never happen for a v1 envelope.
  return 'Tasklists create envelope (no tasklist, no would).';
}
