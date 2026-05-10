import { type CustomFieldsEnumAddData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields enum add` (R43, spec 0057).
 *
 * Live:    `Added enum option "<value>" to field <short-uuid>  (uuid=<short-uuid>).`
 * Dry-run: `[dry-run] Would add enum option "<value>" to field <short-uuid>.`
 */
export function renderCustomFieldsEnumAddHuman(data: CustomFieldsEnumAddData): string {
  const fieldShort = shortUuid(data.field_uuid);
  if (data.would !== undefined) {
    const dryValue = readBodyValue(data.would.body) ?? '<unknown>';
    return `[dry-run] Would add enum option "${dryValue}" to field ${fieldShort}.`;
  }
  if (data.option === undefined) {
    return `Added enum option to field ${fieldShort}.`;
  }
  return `Added enum option "${data.option.value}" to field ${fieldShort}  (uuid=${shortUuid(data.option.uuid)}).`;
}

function readBodyValue(body: unknown): string | undefined {
  if (body === null || typeof body !== 'object') return undefined;
  const raw = (body as Record<string, unknown>)['value'];
  return typeof raw === 'string' ? raw : undefined;
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
