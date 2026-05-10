import { type CustomFieldsEnumRenameData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields enum rename` (R43, spec 0057).
 *
 * Live:    `Renamed enum option <short-uuid> → "<new-value>".`
 * Dry-run: `[dry-run] Would rename enum option <short-uuid> → "<new-value>".`
 */
export function renderCustomFieldsEnumRenameHuman(data: CustomFieldsEnumRenameData): string {
  const newValue = data.applied_changes.value ?? '<unchanged>';
  const prefix = data.would !== undefined ? '[dry-run] Would rename' : 'Renamed';
  return `${prefix} enum option ${shortUuid(data.uuid)} → "${newValue}".`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
