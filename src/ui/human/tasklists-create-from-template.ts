import { type TasklistsCreateFromTemplateData } from '../../api/schemas/tasklist.js';

/**
 * Human renderer for `freelo tasklists create-from-template` (R34, spec 0047).
 *
 * Two shapes:
 *   - Live success: `Created tasklist #ID (NAME) from template #TID (source tasklist #SRC).`
 *   - Dry-run: `(dry-run) Would create tasklist from template #TID (source tasklist #SRC).`
 *     plus indented lines for any non-default flag (target-project, target-tasklist,
 *     date-start, workers).
 *
 * Spec 0047 §3.2.
 */
export function renderTasklistsCreateFromTemplateHuman(
  data: TasklistsCreateFromTemplateData,
): string {
  if (data.would !== undefined) {
    const { tasklist_id, target_project_id, target_tasklist_id, preset_date_from, users_ids } =
      data.would.body;
    const lines: string[] = [
      `(dry-run) Would create tasklist from template #${data.template_id} (source tasklist #${tasklist_id}).`,
    ];
    if (target_project_id !== undefined) lines.push(`  + target-project: ${target_project_id}`);
    if (target_tasklist_id !== undefined) lines.push(`  + target-tasklist: ${target_tasklist_id}`);
    if (preset_date_from !== undefined) lines.push(`  + date-start: ${preset_date_from}`);
    if (users_ids !== undefined && users_ids.length > 0) {
      lines.push(`  + workers: ${users_ids.join(', ')}`);
    }
    return lines.join('\n');
  }

  if (data.tasklist !== undefined) {
    return `Created tasklist #${data.tasklist.id} (${data.tasklist.name}) from template #${data.template_id}.`;
  }

  // Defensive — neither branch matched. Should never happen for a v1 envelope.
  return 'Tasklists create-from-template envelope (no tasklist, no would).';
}
