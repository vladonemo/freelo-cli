import { type ConfigListData } from '../../config/list.js';

/**
 * Human renderer for `freelo config list`.
 * Emits tabular rows with manual column padding (no cli-table3).
 * Columns: KEY, VALUE, SOURCE, WRITABLE
 */
export function renderConfigListHuman(data: ConfigListData): string {
  if (data.keys.length === 0) {
    return 'No configuration keys.';
  }

  // Compute column widths
  const COL_KEY = 'KEY';
  const COL_VALUE = 'VALUE';
  const COL_SOURCE = 'SOURCE';
  const COL_WRITABLE = 'WRITABLE';

  let keyWidth = COL_KEY.length;
  let valueWidth = COL_VALUE.length;
  let sourceWidth = COL_SOURCE.length;

  for (const entry of data.keys) {
    const val = entry.value === null ? '' : String(entry.value);
    if (entry.key.length > keyWidth) keyWidth = entry.key.length;
    if (val.length > valueWidth) valueWidth = val.length;
    if (entry.source.length > sourceWidth) sourceWidth = entry.source.length;
  }

  const pad = (s: string, n: number) => s.padEnd(n, ' ');

  const header = `${pad(COL_KEY, keyWidth)}  ${pad(COL_VALUE, valueWidth)}  ${pad(COL_SOURCE, sourceWidth)}  ${COL_WRITABLE}`;
  const rows = data.keys.map((entry) => {
    const val = entry.value === null ? '' : String(entry.value);
    const writable = entry.writable ? 'yes' : 'no';
    return `${pad(entry.key, keyWidth)}  ${pad(val, valueWidth)}  ${pad(entry.source, sourceWidth)}  ${writable}`;
  });

  return [header, ...rows].join('\n');
}
