import { type ProjectsCreateFromTemplateData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects create-from-template` (R31, spec 0044).
 *
 * Two shapes:
 *   - Live success: `Created project #ID (NAME) from template #TID.`
 *   - Dry-run: `(dry-run) Would create project "NAME" from template #TID.`
 *     plus indented lines for any non-default flag (currency, owner, date,
 *     layout, workers) — same compact one-flag-per-line shape as
 *     R29's `projects-create.ts`.
 *
 * The envelope's `notice` field, if any, is appended by the caller on a
 * separate line — this renderer takes data only.
 *
 * Spec 0044 §3.4.
 */
export function renderProjectsCreateFromTemplateHuman(
  data: ProjectsCreateFromTemplateData,
): string {
  if (data.would !== undefined) {
    const { name, project_owner_id, currency_iso, preset_date_from, general_settings, users_ids } =
      data.would.body;
    const lines: string[] = [
      `(dry-run) Would create project "${name}" from template #${data.template_id}.`,
    ];
    if (currency_iso !== undefined) lines.push(`  + currency: ${currency_iso}`);
    if (project_owner_id !== undefined) lines.push(`  + owner: ${project_owner_id}`);
    if (preset_date_from !== undefined) lines.push(`  + date-start: ${preset_date_from}`);
    if (general_settings !== undefined) lines.push(`  + layout: ${general_settings.layout}`);
    if (users_ids !== undefined && users_ids.length > 0) {
      lines.push(`  + workers: ${users_ids.join(', ')}`);
    }
    return lines.join('\n');
  }

  if (data.project !== undefined) {
    return `Created project #${data.project.id} (${data.project.name}) from template #${data.template_id}.`;
  }

  // Defensive — neither branch matched. Should never happen for a v1 envelope.
  return 'Projects create-from-template envelope (no project, no would).';
}
