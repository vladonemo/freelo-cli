/**
 * Multipart upload helper — first use of `multipart/form-data` in the CLI
 * (R25, spec 0037 §5.1, roadmap.md:753).
 *
 * Uses `undici`'s `FormData` and a `Blob` payload. Eager-loads the file via
 * `readFile` rather than streaming — the documented 100 MB cap (yaml :3873)
 * makes the simplicity worth more than the memory ceiling. Streaming via
 * `undici`'s body iterator can come in a follow-up if real workloads need it.
 *
 * Designed to be reusable: R26 (`files list`) doesn't need it, but R27
 * (`files download`) might want a sibling `buildBlobFromResponse` later.
 *
 * Pure-ish: synchronously throws `ValidationError` on input violations
 * (size, missing path, directory) so callers can `try/catch` once and
 * route to the standard `handleTopLevelError` exit-2 path.
 */

// Use the global FormData (provided by undici under the hood in Node 20+)
// rather than `import { FormData } from 'undici'`. The two classes are NOT
// identical at the prototype level, and the global `fetch` only treats
// values as multipart when they're instances of the *global* FormData. See
// spec 0037 §5.1.
import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { ValidationError } from '../errors/validation-error.js';

/**
 * Documented hard limit for `POST /file/upload` (OpenAPI yaml :3873).
 * 100 MiB. Enforced locally so we don't waste an upload round-trip.
 */
export const FILE_UPLOAD_MAX_BYTES = 100 * 1024 * 1024;

/** Form field name expected by `POST /file/upload` (yaml :3893-3896). */
export const FILE_UPLOAD_FIELD_NAME = 'file';

export type MultipartFile = {
  /** Ready-to-send `FormData` body. Pass directly to `requestMultipart`. */
  body: FormData;
  /** `basename(absPath)` — the value the server sees as filename. */
  filename: string;
  /** Byte count from `stat`. Echoed in the upload envelope for audit. */
  bytes: number;
};

/**
 * Build a `FormData` body for a single-file upload to `POST /file/upload`.
 *
 * Validates locally:
 *   - path exists and is a regular file (not a directory) — `ValidationError`
 *     (exit 2) on mismatch.
 *   - size ≤ `FILE_UPLOAD_MAX_BYTES` — `ValidationError` on overflow (so the
 *     CLI doesn't burn 100 MB of egress to learn the server says 400).
 *
 * On read failure (e.g. the file vanished between `stat` and `readFile`),
 * propagates the underlying `Error` wrapped in a `ValidationError` so callers
 * see a typed exit code rather than a process-killing rejection. This is
 * deliberately **not** `NetworkError` — the failure is local I/O.
 */
export async function buildFileMultipart(absPath: string): Promise<MultipartFile> {
  let stats;
  try {
    stats = await stat(absPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Cannot read path "${absPath}": ${message}`, {
      hintNext: 'Pass an existing local file path (no globbing — let the shell expand).',
    });
  }

  if (!stats.isFile()) {
    throw new ValidationError(`Path "${absPath}" is not a regular file.`, {
      hintNext: 'Directories are not uploaded recursively. Pass file paths only.',
    });
  }

  if (stats.size > FILE_UPLOAD_MAX_BYTES) {
    throw new ValidationError(
      `File "${absPath}" is ${stats.size} bytes — exceeds the 100 MB upload limit.`,
      {
        hintNext: 'Split the file or compress it before uploading.',
      },
    );
  }

  let buffer: Buffer;
  try {
    buffer = await readFile(absPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ValidationError(`Failed to read "${absPath}": ${message}`, {
      hintNext: 'Check file permissions and that the path still exists.',
    });
  }

  const body = new FormData();
  // Blob constructor accepts BlobPart[]. Buffer is a BlobPart in Node 20+
  // (Uint8Array-compatible). The cast keeps the lib dom-typed `BlobPart` happy
  // without pulling in node-fetch types.
  const blob = new Blob([buffer as unknown as ArrayBuffer], {
    type: 'application/octet-stream',
  });
  const filename = basename(absPath);
  body.append(FILE_UPLOAD_FIELD_NAME, blob, filename);

  return { body, filename, bytes: stats.size };
}
