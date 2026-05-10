import { type CustomFieldsCreateData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields create` (R41, spec 0055).
 *
 * Live success:
 *   `Created custom field "<name>" on project #<project_id> (uuid=<short>).`
 *
 * Dry-run:
 *   `[dry-run] Would create custom field "<name>" on project #<project_id>.`
 *
 * UUIDs are abbreviated for terminal readability; agents should use
 * `--output json` for the full uuid.
 */
export function renderCustomFieldsCreateHuman(data: CustomFieldsCreateData): string {
  if (data.custom_field === undefined) {
    // Dry-run path. The would.body carries `name`; falling back to a generic
    // line if it isn't a string keeps the renderer total.
    const wouldBody = data.would?.body as { name?: unknown } | undefined;
    const name =
      wouldBody !== undefined && typeof wouldBody.name === 'string' ? wouldBody.name : '<unnamed>';
    return `[dry-run] Would create custom field "${name}" on project #${String(data.project_id)}.`;
  }
  return `Created custom field "${data.custom_field.name}" on project #${String(data.project_id)} (uuid=${shortUuid(data.custom_field.uuid)}).`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
