import { type CustomFieldsDeleteData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields delete` (R41, spec 0055).
 *
 * Live success:        `Deleted custom field <short-uuid>.`
 * Idempotent skip:     `Already deleted: custom field <short-uuid>.`
 * Dry-run:             `[dry-run] Would delete custom field <short-uuid>.`
 */
export function renderCustomFieldsDeleteHuman(data: CustomFieldsDeleteData): string {
  if (data.would !== undefined) {
    return `[dry-run] Would delete custom field ${shortUuid(data.uuid)}.`;
  }
  if (data.already_in_target_state) {
    return `Already deleted: custom field ${shortUuid(data.uuid)}.`;
  }
  return `Deleted custom field ${shortUuid(data.uuid)}.`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
