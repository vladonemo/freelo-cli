/**
 * `Content-Disposition` parsing + filename sanitization.
 *
 * Used by `freelo files download` (R27, spec 0039 §3.3) to infer a
 * destination filename from the response header when the user did not
 * pass `-o <path>`.
 *
 * Threat model: the server is **untrusted** when emitting filenames.
 * `Content-Disposition: attachment; filename="../../etc/passwd"` must
 * NEVER escape `process.cwd()`. Spec 0039 decision 06.
 */

/**
 * Parse `Content-Disposition` per RFC 6266 (best-effort). Recognizes:
 *
 *   - `attachment; filename="report.pdf"`
 *   - `attachment; filename=report.pdf` (unquoted token)
 *   - `attachment; filename*=UTF-8''na%C3%AFve.txt` (RFC 5987 percent-encoded)
 *
 * Returns the **raw** filename as the server sent it (post percent-decode
 * for `filename*`). The caller MUST pass the result through
 * `sanitizeBasename` before using it as a filesystem path component.
 *
 * Returns `null` when the header is missing, malformed, or contains no
 * `filename` parameter.
 */
export function parseContentDisposition(header: string | null | undefined): string | null {
  if (header === null || header === undefined) return null;
  const trimmed = header.trim();
  if (trimmed.length === 0) return null;

  // Prefer `filename*` (RFC 5987 extended form) when present — it's how
  // servers express non-ASCII filenames safely.
  const star = matchFilenameStar(trimmed);
  if (star !== null) return star;

  return matchFilenamePlain(trimmed);
}

/**
 * Match `filename*=charset'lang'value` (RFC 5987). Only `UTF-8` is
 * supported; anything else returns `null`. Percent-decoded.
 */
function matchFilenameStar(header: string): string | null {
  // The pattern allows arbitrary whitespace around `=`.
  const re = /filename\*\s*=\s*([^']+)'[^']*'([^;\s]+)/i;
  const m = re.exec(header);
  if (m === null) return null;
  const charset = m[1]?.toLowerCase().trim();
  const value = m[2];
  if (charset !== 'utf-8' || value === undefined) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/**
 * Match plain `filename="…"` or `filename=token`. Returns the unquoted
 * value. Quoted-pair (`\"`) is unescaped.
 */
function matchFilenamePlain(header: string): string | null {
  // Quoted form: filename="..." (handles \" escapes).
  const quotedRe = /filename\s*=\s*"((?:[^"\\]|\\.)*)"/i;
  const quoted = quotedRe.exec(header);
  if (quoted !== null && quoted[1] !== undefined) {
    // Unescape \" and \\.
    return quoted[1].replace(/\\(.)/g, '$1');
  }
  // Token form: filename=foo.bar (stops at `;` or whitespace).
  const tokenRe = /filename\s*=\s*([^;\s]+)/i;
  const token = tokenRe.exec(header);
  if (token !== null && token[1] !== undefined && token[1].length > 0) {
    return token[1];
  }
  return null;
}

/**
 * Strip a server-provided filename of every component that could escape
 * the destination directory. Returns the bare safe basename, or an empty
 * string if nothing safe remains.
 *
 * Steps:
 *   1. Strip any path components — keep only the segment after the last
 *      `/` or `\`.
 *   2. Reject leading `.` (hidden files / `..`).
 *   3. Reject the literals `.` and `..`.
 *   4. Strip control characters (0x00–0x1F).
 *   5. Cap length at 255 chars (most fs limits).
 *
 * The intent: a malicious `Content-Disposition: attachment;
 * filename="../../../etc/passwd"` becomes `'passwd'`. A
 * `filename=".env"` becomes `''` (caller falls back to UUID-based name).
 *
 * NOT applied to `-o <path>` arguments — those are user intent.
 */
export function sanitizeBasename(raw: string): string {
  if (raw.length === 0) return '';

  // Replace backslashes with forward slashes so the split below catches
  // Windows-style separators uniformly.
  const normalized = raw.replace(/\\/g, '/');

  // Take the last segment.
  const last = normalized.split('/').pop() ?? '';

  // Reject `.` and `..` literals.
  if (last === '.' || last === '..') return '';

  // Reject leading `.` to avoid hidden-file surprises (`.bashrc`).
  if (last.startsWith('.')) return '';

  // Strip control chars (0x00-0x1F) which can confuse downstream tools.
  // eslint-disable-next-line no-control-regex
  const stripped = last.replace(/[\x00-\x1f]/g, '');

  if (stripped.length === 0) return '';

  // Cap at 255 chars (typical fs limit on ext4 / NTFS / APFS).
  return stripped.slice(0, 255);
}
