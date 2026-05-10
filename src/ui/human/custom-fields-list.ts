import { type CustomFieldsListData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields list` (R40, spec 0054).
 *
 * Empty: `Project #<id> — no custom fields, is_commander=<bool>.`
 * Non-empty:
 *   ```
 *   Project #<id> — N custom field(s), is_commander=<bool>:
 *     <name>  type=<short-uuid>  priority=<n>  uuid=<short-uuid>
 *   ```
 *
 * UUIDs are abbreviated to the first 8 chars + "…" so the human view stays
 * readable on an 80-col terminal. Agents that need full UUIDs use
 * `--output json`.
 */
export function renderCustomFieldsListHuman(data: CustomFieldsListData): string {
  const trailerEmpty = `Project #${String(data.project_id)} — no custom fields, is_commander=${String(data.is_commander)}.`;
  if (data.custom_fields.length === 0) {
    return trailerEmpty;
  }
  const header = `Project #${String(data.project_id)} — ${String(data.custom_fields.length)} custom field(s), is_commander=${String(data.is_commander)}:`;
  const lines = data.custom_fields.map((f) => {
    const parts = [
      `  ${f.name}`,
      `type=${shortUuid(f.custom_fields_types_uuid ?? '')}`,
      `priority=${f.priority === undefined || f.priority === null ? '-' : String(f.priority)}`,
      `uuid=${shortUuid(f.uuid)}`,
    ];
    return parts.join('  ');
  });
  return [header, ...lines].join('\n');
}

function shortUuid(raw: string): string {
  if (raw.length === 0) return '-';
  if (raw.length <= 9) return raw;
  return `${raw.slice(0, 8)}…`;
}
