import { type Envelope } from './envelope.js';

export type ResolvedOutputMode = 'human' | 'json' | 'ndjson';

/**
 * Dispatch an envelope to the appropriate output path.
 *
 * - `json` / `ndjson` — serialize to JSON and write a single `\n`-terminated
 *   line to stdout. (For list commands in R03+, `ndjson` will write one line
 *   per record; for single-object commands it is identical to `json`.)
 * - `human` — call `humanRenderer(envelope.data)` and write the returned
 *   string to stdout.
 * - `auto` should have been resolved to `human` or `json` before calling this
 *   function; if it somehow reaches here it is treated as `json`.
 */
export function render<T>(
  mode: ResolvedOutputMode | 'auto',
  envelope: Envelope<T>,
  humanRenderer: (data: T) => string,
): void {
  if (mode === 'human') {
    const output = humanRenderer(envelope.data);
    process.stdout.write(output.endsWith('\n') ? output : `${output}\n`);
    return;
  }
  // json, ndjson, auto (fallback)
  process.stdout.write(`${JSON.stringify(envelope)}\n`);
}
