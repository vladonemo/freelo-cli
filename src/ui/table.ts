/**
 * Lazy `cli-table3` wrapper.
 *
 * Per `.claude/docs/conventions.md` §Imports and the project ESLint policy,
 * `cli-table3` is a human-UX dependency and must NEVER be imported at the
 * top of a module — agents on the cold path must not pay for it. Use
 * `await renderTable(...)` from inside an action handler that has already
 * resolved `mode === 'human'`.
 *
 * Spec 0009 §2.6 sets the column policy: name column truncated at 40 chars
 * with `…`, other columns auto-size, no color on data, headers in plain text.
 */

export type RenderTableOptions = {
  /** Cap width on the "name" column; longer values are truncated with `…`. */
  maxNameWidth?: number;
  /** Index of the column to apply `maxNameWidth` to (default: 1, the second column). */
  nameColumnIndex?: number;
};

const DEFAULT_NAME_WIDTH = 40;
const DEFAULT_NAME_COLUMN_INDEX = 1;

/**
 * Coerce an arbitrary cell value to a printable string. Distinct from
 * `String(value)` because objects without a custom `toString` would render
 * as `[object Object]` — we JSON-stringify them instead.
 */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'bigint') return value.toString();
  // Object / array / etc.
  try {
    return JSON.stringify(value);
  } catch {
    return '';
  }
}

/**
 * Truncate a value to `max` characters, replacing the last char with `…` when
 * the value is longer. Single Unicode ellipsis matches the spec.
 */
export function truncateCell(value: string, max: number): string {
  if (max <= 0) return '';
  if (value.length <= max) return value;
  if (max === 1) return '…';
  return `${value.slice(0, max - 1)}…`;
}

/**
 * Render a table with the given headers and rows. All cells are coerced to
 * string before formatting.
 *
 * `cli-table3` is loaded lazily inside the function body. The dynamic import
 * is the only entry point in the codebase per ESLint's `no-restricted-imports`
 * rule (verified by `test/ui/table.test.ts`).
 */
export async function renderTable(
  headers: string[],
  rows: ReadonlyArray<ReadonlyArray<unknown>>,
  opts: RenderTableOptions = {},
): Promise<string> {
  const max = opts.maxNameWidth ?? DEFAULT_NAME_WIDTH;
  const nameIdx = opts.nameColumnIndex ?? DEFAULT_NAME_COLUMN_INDEX;

  const mod = await import('cli-table3');
  // cli-table3 is a CJS module; default export is the constructor.
  const Table = (mod as { default: new (opts: unknown) => unknown }).default;

  const table = new Table({
    head: headers,
    style: { head: [], border: [] },
  }) as {
    push(row: string[]): void;
    toString(): string;
  };

  for (const row of rows) {
    const formatted = row.map((cell, i) => {
      const s = stringifyCell(cell);
      if (i === nameIdx) return truncateCell(s, max);
      return s;
    });
    table.push(formatted);
  }

  return table.toString();
}
