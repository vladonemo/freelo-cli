import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrapper for M07 `files delete` (spec 0064).
 *
 * `DELETE /file/{file_uuid}` — soft-deletes a **file or a document/note**.
 * OpenAPI :4492-4521 (`operationId: deleteDocOrFileByUuid`).
 *
 * The endpoint resolves the resource kind from the UUID server-side (yaml
 * :4497), so one command covers both. Empty request body. The declared 200 is
 * a bare `SuccessResponse` with no per-resource detail — notably no
 * discriminator telling us whether a file or a document was removed — so there
 * is nothing server-derived for the CLI to surface; the command layer derives
 * `current_state: 'deleted'` from the verb.
 *
 * **No 404 special-casing here — and none in the command layer either.**
 * `src/api/tasks-delete.ts` documents that its command layer re-classifies a
 * 404 as an idempotent already-deleted success; `files delete` deliberately
 * does NOT (spec 0064 §5.1 / decision 3). Per yaml :4504 a 404 on this endpoint
 * means *either* "no file or document matches the UUID" *or* "the caller has no
 * access to it" — Freelo returns 404 rather than 403 so inaccessible resources
 * aren't leaked — so absorbing it would report success for a document still
 * sitting untouched in someone else's project. This wrapper lets
 * `FreeloApiError` (`code: 'NOT_FOUND'`) bubble untouched.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `comments-delete.ts` and
 * `tasks-delete.ts`).
 *
 * Parsed defensively so a malformed 2xx body still trips validation; the parsed
 * value is never surfaced.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type DeleteFileOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type DeleteFileResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for a delete call. Exposed so `--dry-run` envelopes can
 * echo the path without re-running the network branch.
 *
 * The UUID is interpolated verbatim — callers validate it against the
 * 8-4-4-4-12 pattern before we get here (spec 0064 §4.4), so there is no
 * path-injection surface.
 */
export function deleteFilePath(uuid: string): string {
  return `/file/${uuid}`;
}

/**
 * `DELETE /file/{file_uuid}` — soft-delete a file or document/note.
 *
 * Empty body (no Content-Type header set — see `client.ts:114`). The one
 * endpoint-specific failure the command layer rewrites (spec 0064 §5.2) is the
 * `404`, which means the resource is missing *or* invisible to the caller. It
 * bubbles from here as an ordinary `FreeloApiError`; the message/hint rewriting
 * lives in `src/commands/files/delete.ts` so this wrapper stays reusable.
 *
 * Spec 0064 §3.
 */
export async function deleteFile(
  client: HttpClient,
  uuid: string,
  opts: DeleteFileOpts = {},
): Promise<DeleteFileResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteFilePath(uuid),
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
