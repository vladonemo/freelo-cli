import { z } from 'zod';
import { ValidationError } from '../errors/validation-error.js';

/**
 * Writable keys — the allow-list for `config set` and `config unset`.
 * Maps each key to its per-key zod validator. All values arrive as strings
 * from the CLI; validators coerce as needed.
 *
 * See spec §4.6 and §2.2.
 */
export const WRITABLE_KEYS = {
  output: z.enum(['auto', 'human', 'json', 'ndjson']),
  color: z.enum(['auto', 'never', 'always']),
  profile: z.string().min(1),
  apiBaseUrl: z.string().url(),
  verbose: z.enum(['0', '1', '2']).transform((s) => Number(s) as 0 | 1 | 2),
} as const;

export type WritableKey = keyof typeof WRITABLE_KEYS;

/**
 * Read-only keys — known to `config get` and `config list` but not settable.
 */
export const READONLY_KEYS = [
  'email',
  'apiKey',
  'requestId',
  'yes',
  'userAgent',
  'profileSource',
] as const;

export type ReadOnlyKey = (typeof READONLY_KEYS)[number];

/**
 * All known keys (writable + read-only).
 */
export type KnownKey = WritableKey | ReadOnlyKey;

/** True when `key` is in the read-only set. */
export function isReadOnlyKey(key: string): key is ReadOnlyKey {
  return (READONLY_KEYS as readonly string[]).includes(key);
}

/** True when `key` is in the writable set. */
export function isWritableKey(key: string): key is WritableKey {
  return key in WRITABLE_KEYS;
}

/** True when `key` is known (writable or read-only). */
export function isKnownKey(key: string): key is KnownKey {
  return isWritableKey(key) || isReadOnlyKey(key);
}

/**
 * Parse and validate a raw string value for a writable key.
 *
 * Returns the coerced value (e.g. `verbose '2'` → number `2`).
 * Throws `ValidationError` with `field: key` on failure.
 */
export function parseValue(key: WritableKey, rawString: string): unknown {
  const schema = WRITABLE_KEYS[key];
  const result = (schema as z.ZodType).safeParse(rawString);
  if (!result.success) {
    throw new ValidationError(
      `Invalid value '${rawString}' for key '${key}': ${result.error.issues.map((i) => i.message).join(', ')}`,
      { field: key, value: rawString },
    );
  }
  return result.data;
}

/**
 * Where a writable key's value is stored:
 * - `'defaults'`       → `store.defaults.<key>`
 * - `'profile'`        → `store.profiles[activeProfile].apiBaseUrl`
 * - `'currentProfile'` → `store.currentProfile`
 */
export type KeyScope = 'defaults' | 'profile' | 'currentProfile';

/**
 * Returns the storage scope for a writable key.
 */
export function keyScope(key: WritableKey): KeyScope {
  switch (key) {
    case 'apiBaseUrl':
      return 'profile';
    case 'profile':
      return 'currentProfile';
    default:
      // output, color, verbose
      return 'defaults';
  }
}
