/**
 * The single place that reads TTY state, NO_COLOR, FORCE_COLOR, CI, and the
 * FREELO_OUTPUT / FREELO_COLOR / FREELO_DEBUG env vars.
 *
 * All other modules import from here — no direct `process.env` / `process.stdout.isTTY`
 * reads outside this file and `src/bin/freelo.ts` (which calls into here).
 */

export type OutputMode = 'auto' | 'human' | 'json' | 'ndjson';
export type ColorMode = 'auto' | 'never' | 'always';
export type ResolvedOutputMode = 'human' | 'json' | 'ndjson';

/**
 * Returns `true` when both stdin and stdout are TTYs and `CI` is not set to a
 * truthy value.
 *
 * Agents and pipes always return `false`. This is the gate in front of every
 * lazy human-UX import.
 */
export function isInteractive(): boolean {
  const ci = process.env['CI'];
  if (ci && ci !== '0' && ci.toLowerCase() !== 'false') return false;
  return Boolean(process.stdout.isTTY && process.stdin.isTTY);
}

/**
 * Returns `true` when color output is wanted.
 *
 * Precedence:
 *   1. `NO_COLOR` in env → always false (regardless of flag)
 *   2. `FORCE_COLOR` in env → always true
 *   3. `flag` argument (from `--color`)
 *   4. Fallback: true if stdout is a TTY, false otherwise
 */
export function wantsColor(flag: ColorMode): boolean {
  if (process.env['NO_COLOR'] !== undefined) return false;
  if (process.env['FORCE_COLOR'] !== undefined) return true;
  if (flag === 'never') return false;
  if (flag === 'always') return true;
  // 'auto'
  return Boolean(process.stdout.isTTY);
}

/**
 * Resolve the abstract `--output auto` to a concrete mode.
 *
 * `auto` → `json` when stdout is not a TTY (agent/pipe path), `human` otherwise.
 * `human` / `json` / `ndjson` pass through unchanged.
 */
export function resolveOutputMode(flag: OutputMode): ResolvedOutputMode {
  if (flag === 'auto') {
    return process.stdout.isTTY ? 'human' : 'json';
  }
  return flag;
}
