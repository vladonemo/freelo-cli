import { type CustomFieldsValueClearData } from '../../api/schemas/custom-field.js';

/**
 * Human renderer for `freelo custom-fields value clear` (R42, spec 0055).
 *
 * Three shapes, gated on `data.would` and `data.already_in_target_state`:
 *   - Live success:   `Cleared value on task #ID, field <short-uuid>.`
 *   - Already absent: `Task #ID, field <short-uuid> already had no value.`
 *   - Dry-run:        `(dry-run) Would clear value on task #ID, field <short-uuid>.`
 */
export function renderCustomFieldsValueClearHuman(data: CustomFieldsValueClearData): string {
  const fieldShort = shortUuid(data.field_uuid);
  if (data.would !== undefined) {
    return `(dry-run) Would clear value on task #${String(data.task_id)}, field ${fieldShort}.`;
  }
  if (data.already_in_target_state) {
    return `Task #${String(data.task_id)}, field ${fieldShort} already had no value.`;
  }
  return `Cleared value on task #${String(data.task_id)}, field ${fieldShort}.`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
