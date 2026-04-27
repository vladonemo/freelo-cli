/**
 * URL query-string encoder for the Freelo CLI.
 *
 * Handles the three shapes Freelo's API expects:
 *
 *  1. **Repeating arrays** for params declared as `name[]` in the OpenAPI spec.
 *     `{ 'projects_ids[]': [42, 43] }` →
 *     `projects_ids%5B%5D=42&projects_ids%5B%5D=43`.
 *  2. **Bracketed objects** for date-range and similar nested params.
 *     `{ 'due_date_range[date_from]': '2026-04-01' }` →
 *     `due_date_range%5Bdate_from%5D=2026-04-01`.
 *  3. **Scalars** (string / number / boolean) for everything else.
 *     `{ p: 0, no_due_date: true }` → `p=0&no_due_date=true`.
 *
 * Encoding rules:
 *
 *  - Array values (`number[] | string[]`) are emitted as repeating
 *    `key=value` pairs, in the order they appear in the array.
 *    `URLSearchParams.append` percent-encodes the bracketed key (`[]`) once.
 *  - Boolean `true` → `"true"`. Boolean `false` → omitted entirely. Freelo's
 *    boolean filters all default to `false`; emitting `false` would just bloat
 *    the URL with no semantic effect.
 *  - `undefined` values are omitted.
 *  - Numeric values are coerced via `String(value)`.
 *  - Empty arrays are omitted (no `key[]=`).
 *
 * The returned string has **no leading `?`** — callers compose the final URL
 * (typically `path = base + '?' + buildQuery(params)`).
 *
 * Per spec 0017 §2.5, the CLI **never** emits the deprecated singular
 * `with_label` form. This is enforced at the call site (the leaf command only
 * ever passes `with_labels[]`). `buildQuery` itself accepts any key — the
 * policy lives in the caller, not here, to keep the helper general-purpose.
 */
export function buildQuery(
  params: Readonly<
    Record<string, string | number | boolean | readonly (string | number)[] | undefined>
  >,
): string {
  const out = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      // Empty arrays: omit entirely. Caller doesn't need a `key[]=` placeholder.
      if (value.length === 0) continue;
      for (const item of value) {
        out.append(key, String(item));
      }
      continue;
    }
    if (typeof value === 'boolean') {
      // Default-false params: omit when false. Spec 0017 §2.5.
      if (!value) continue;
      out.append(key, 'true');
      continue;
    }
    out.append(key, String(value));
  }
  return out.toString();
}
