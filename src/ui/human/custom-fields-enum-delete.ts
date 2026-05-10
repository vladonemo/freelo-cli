import { type CustomFieldsEnumDeleteData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields enum delete` (R43, spec 0057).
 *
 * Live (safe):       `Deleted enum option <short-uuid>.`
 * Live (--force):    `Force-deleted enum option <short-uuid> (referencing task values cleared).`
 * Idempotent skip:   `Already deleted: enum option <short-uuid>.`
 * Dry-run (safe):    `[dry-run] Would delete enum option <short-uuid>.`
 * Dry-run (--force): `[dry-run] Would force-delete enum option <short-uuid> (referencing task values would be cleared).`
 */
export function renderCustomFieldsEnumDeleteHuman(data: CustomFieldsEnumDeleteData): string {
  if (data.would !== undefined) {
    if (data.force) {
      return `[dry-run] Would force-delete enum option ${shortUuid(data.uuid)} (referencing task values would be cleared).`;
    }
    return `[dry-run] Would delete enum option ${shortUuid(data.uuid)}.`;
  }
  if (data.already_in_target_state) {
    return `Already deleted: enum option ${shortUuid(data.uuid)}.`;
  }
  if (data.force) {
    return `Force-deleted enum option ${shortUuid(data.uuid)} (referencing task values cleared).`;
  }
  return `Deleted enum option ${shortUuid(data.uuid)}.`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
