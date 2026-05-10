import { type CustomFieldsTypesData } from '../../api/schemas/custom-field.js';

/**
 * Human-mode renderer for `freelo custom-fields types` (R40, spec 0054).
 *
 * Two-column output: name (left-padded to the longest name) then uuid.
 * Empty catalog gets a single "no custom-field types." line — defensive,
 * Freelo's catalog has three documented entries (text / number / enum)
 * but `.passthrough()` accepts an empty array.
 *
 * Examples:
 *   text     2f7bfe3a-c950-470e-b910-95b4caf5dc4f
 *   number   b1e56fa9-a97a-429b-8ab4-82bebe58933a
 *   enum     f9729a8f-d340-40e4-b2c0-dc46c37e18ce
 *
 *   no custom-field types.
 */
export function renderCustomFieldsTypesHuman(data: CustomFieldsTypesData): string {
  if (data.types.length === 0) {
    return 'no custom-field types.';
  }
  const widest = data.types.reduce((acc, t) => Math.max(acc, t.name.length), 0);
  const lines = data.types.map((t) => `${t.name.padEnd(widest)}  ${t.uuid}`);
  return lines.join('\n');
}
