/**
 * The canonical list of keys that may carry secrets. Shared by `FreeloApiError`
 * and the pino serializer so both paths apply the same redaction.
 */
export const SECRET_KEYS: ReadonlySet<string> = new Set([
  'authorization',
  'email',
  'password',
  'api_key',
  'apiKey',
  'token',
]);

type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

/**
 * Deep-clone `obj`, replacing any value whose key appears in `SECRET_KEYS`
 * with the string `"[redacted]"`. Preserves structure and sibling keys.
 */
export function scrubSecrets(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(scrubSecrets);
  }
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, JsonValue> = {};
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      result[k] = SECRET_KEYS.has(k.toLowerCase()) ? '[redacted]' : (scrubSecrets(v) as JsonValue);
    }
    return result;
  }
  return obj;
}
