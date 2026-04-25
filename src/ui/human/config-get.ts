import { type ConfigKeyEntry } from '../../config/list.js';

/**
 * Human renderer for `freelo config get`.
 * Emits one line: `<key>: <value> (source: <source>)`.
 * Appends `[read-only]` for non-writable keys.
 */
export function renderConfigGetHuman(data: ConfigKeyEntry): string {
  const val = data.value === null ? '' : String(data.value);
  const ro = data.writable ? '' : ' [read-only]';
  return `${data.key}: ${val} (source: ${data.source})${ro}`;
}
