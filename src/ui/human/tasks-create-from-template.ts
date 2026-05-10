import { type TasksCreateFromTemplateData } from '../../api/schemas/task-create-from-template.js';

/**
 * Human renderer for `freelo tasks create-from-template` (R39, spec 0053).
 *
 * Two shapes:
 *   - Live success: `Created task #ID (NAME) from template #TID (in tasklist #TLID, "TLNAME").`
 *     If the embedded tasklist name is null/missing (R05.5 hardening), the
 *     `, "TLNAME"` parenthetical is dropped — leaves `(in tasklist #TLID).`.
 *   - Dry-run: `(dry-run) Would create task from template #TID (source task #SRC).`
 *     plus indented sub-lines for any non-default flag (target-project,
 *     target-tasklist, date-start, workers).
 *
 * Spec 0053 §3.4. Mirrors `src/ui/human/tasklists-create-from-template.ts`.
 */
export function renderTasksCreateFromTemplateHuman(data: TasksCreateFromTemplateData): string {
  if (data.would !== undefined) {
    const { task_id, target_project_id, target_tasklist_id, preset_date_from, users_ids } =
      data.would.body;
    const lines: string[] = [
      `(dry-run) Would create task from template #${data.template_id} (source task #${task_id}).`,
    ];
    if (target_project_id !== undefined) lines.push(`  + target-project: ${target_project_id}`);
    if (target_tasklist_id !== undefined) lines.push(`  + target-tasklist: ${target_tasklist_id}`);
    if (preset_date_from !== undefined) lines.push(`  + date-start: ${preset_date_from}`);
    if (users_ids !== undefined && users_ids.length > 0) {
      lines.push(`  + workers: ${users_ids.join(', ')}`);
    }
    return lines.join('\n');
  }

  if (data.task !== undefined) {
    const tlName = data.task.tasklist.name;
    const tlPart =
      tlName === null || tlName === undefined || tlName === ''
        ? `in tasklist #${data.task.tasklist.id}`
        : `in tasklist #${data.task.tasklist.id}, "${tlName}"`;
    return `Created task #${data.task.id} (${data.task.name}) from template #${data.template_id} (${tlPart}).`;
  }

  // Defensive — neither branch matched. Should never happen for a v1 envelope.
  return 'Tasks create-from-template envelope (no task, no would).';
}
