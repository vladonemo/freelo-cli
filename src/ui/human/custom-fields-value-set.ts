import { type CustomFieldsValueSetData } from '../../api/schemas/custom-field.js';

/**
 * Human renderer for `freelo custom-fields value set` (R42, spec 0055).
 *
 * Two shapes, gated on `data.would`:
 *   - Live success: `Set <kind> value on task #ID, field <short-uuid> = <value>.`
 *   - Dry-run:      `(dry-run) Would set <kind> value on task #ID, field <short-uuid> = <value>.`
 *
 * `value` is shortened when it looks like a uuid (enum case) so the
 * 80-col view stays readable; full value available via `--output json`.
 */
export function renderCustomFieldsValueSetHuman(data: CustomFieldsValueSetData): string {
  const fieldShort = shortUuid(data.field_uuid);
  const valueShort = data.kind === 'enum' ? shortUuid(data.value) : truncate(data.value, 60);
  const head = `${data.kind} value on task #${String(data.task_id)}, field ${fieldShort} = ${valueShort}`;
  if (data.would !== undefined) {
    return `(dry-run) Would set ${head}.`;
  }
  return `Set ${head}.`;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}

function truncate(raw: string, max: number): string {
  if (raw.length <= max) return raw;
  return `${raw.slice(0, max)}…`;
}
