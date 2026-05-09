import { type ProjectsCreateData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects create` (R29, spec 0042).
 *
 * Two shapes:
 *   - Live success: `Created project #ID (NAME).`
 *   - Dry-run: `(dry-run) Would create project "NAME" (currency: CODE).`
 *     plus a "  + owner: ID" line when `--project-owner-id` was set.
 *
 * The envelope's `notice` field, if any, is appended by the caller on a
 * separate line — this renderer takes data only.
 *
 * Spec 0042 §3.4.
 */
export function renderProjectsCreateHuman(data: ProjectsCreateData): string {
  if (data.would !== undefined) {
    const { name, currency_iso, project_owner_id } = data.would.body;
    const lines: string[] = [
      `(dry-run) Would create project "${name}" (currency: ${currency_iso}).`,
    ];
    if (project_owner_id !== undefined) {
      lines.push(`  + owner: ${project_owner_id}`);
    }
    return lines.join('\n');
  }

  if (data.project !== undefined) {
    return `Created project #${data.project.id} (${data.project.name}).`;
  }

  // Defensive — neither branch matched. Should never happen for a v1 envelope.
  return 'Projects create envelope (no project, no would).';
}
