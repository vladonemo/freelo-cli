import { type CustomFieldsRestoreData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields restore` (R41, spec 0055).
 *
 * Live success:        `Restored custom field "<name>" (uuid=<short>).`
 * Idempotent skip:     `Already active: custom field <short-uuid>.`
 * Dry-run:             `[dry-run] Would restore custom field <short-uuid>.`
 */
export function renderCustomFieldsRestoreHuman(data: CustomFieldsRestoreData): string {
  if (data.would !== undefined) {
    return `[dry-run] Would restore custom field ${shortUuid(data.uuid)}.`;
  }
  if (data.already_in_target_state) {
    return `Already active: custom field ${shortUuid(data.uuid)}.`;
  }
  if (data.custom_field !== undefined) {
    return `Restored custom field "${data.custom_field.name}" (uuid=${shortUuid(data.uuid)}).`;
  }
  return `Restored custom field ${shortUuid(data.uuid)}.`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
