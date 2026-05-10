import { type CustomFieldsRenameData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields rename` (R41, spec 0055).
 *
 * Live: `Renamed custom field <short-uuid> → "<new-name>".`
 * Dry-run: `[dry-run] Would rename custom field <short-uuid> → "<new-name>".`
 */
export function renderCustomFieldsRenameHuman(data: CustomFieldsRenameData): string {
  const newName = data.applied_changes.name ?? '<unchanged>';
  const prefix = data.would !== undefined ? '[dry-run] Would rename' : 'Renamed';
  return `${prefix} custom field ${shortUuid(data.uuid)} → "${newName}".`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
