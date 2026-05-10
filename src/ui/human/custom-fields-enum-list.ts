import { type CustomFieldsEnumListData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields enum list` (R43, spec 0057).
 *
 * Empty:
 *   `Field <short-uuid> — no enum options.`
 *
 * Non-empty:
 *   ```
 *   Field <short-uuid> — N enum option(s):
 *     "<value>"  uuid=<short-uuid>
 *   ```
 *
 * UUIDs are abbreviated; agents that need full UUIDs use `--output json`.
 */
export function renderCustomFieldsEnumListHuman(data: CustomFieldsEnumListData): string {
  const fieldShort = shortUuid(data.field_uuid);
  if (data.options.length === 0) {
    return `Field ${fieldShort} — no enum options.`;
  }
  const header = `Field ${fieldShort} — ${String(data.options.length)} enum option(s):`;
  const lines = data.options.map((opt) => `  "${opt.value}"  uuid=${shortUuid(opt.uuid)}`);
  return [header, ...lines].join('\n');
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
