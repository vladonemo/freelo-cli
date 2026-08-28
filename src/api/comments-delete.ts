import { z } from 'zod';
import { type ApiResponse, type HttpClient } from './client.js';

/**
 * Wire wrapper for M01 `comments delete` (spec 0061).
 *
 * `DELETE /comment/{comment_id}` — deletes a comment. OpenAPI :3203-3232
 * (`operationId: deleteComment`).
 *
 * Empty request body. The OpenAPI declares a bare `200 Comment deleted` with
 * **no response schema** (unlike `editComment`, which returns a `Comment`), so
 * there is nothing server-derived for the CLI to surface — the command layer
 * derives `current_state: 'deleted'` from the verb.
 *
 * **No 404 special-casing here — and none in the command layer either.**
 * `src/api/tasks-delete.ts` documents that its command layer re-classifies a
 * 404 as idempotent already-deleted; `comments delete` deliberately does NOT
 * (spec 0061 §5.1 / decision 1). Per yaml :3216 a 404 on this endpoint means
 * *either* "no such comment" *or* "you are not its author" — Freelo returns
 * 404 rather than 403 so that inaccessible comments aren't leaked — so
 * absorbing it would report success for a comment that is still in the thread.
 * This wrapper lets `FreeloApiError` (`code: 'NOT_FOUND'`) bubble untouched.
 */

/**
 * Generic Freelo success envelope (`{ result: 'success' }`). Tolerates
 * additional fields via `passthrough()` — Freelo extends success bodies
 * occasionally without a contract bump (mirrors `tasks-delete.ts`).
 *
 * The endpoint declares no 200 schema, so this is a defensive parse of
 * whatever comes back; the parsed value is never surfaced.
 */
const SuccessResponseSchema = z
  .object({
    result: z.string().nullable().optional(),
  })
  .passthrough();

export type DeleteCommentOpts = {
  signal?: AbortSignal;
  requestId?: string;
};

export type DeleteCommentResult = {
  raw: ApiResponse<unknown>;
};

/**
 * Resolve the wire path for a delete call. Exposed so `--dry-run` envelopes
 * can echo the path without re-running the network branch.
 */
export function deleteCommentPath(commentId: number): string {
  return `/comment/${commentId}`;
}

/**
 * `DELETE /comment/{comment_id}` — delete a comment.
 *
 * Empty body (no Content-Type header set — see `client.ts:114`). Two
 * endpoint-specific failures the command layer rewrites (spec 0061 §5):
 *
 *   - `400` — the 15-minute post-time deletion window has expired.
 *   - `404` — comment missing *or* not authored by the caller.
 *
 * Both bubble from here as ordinary `FreeloApiError`s; the message/hint
 * rewriting lives in `src/commands/comments/delete.ts` so this wrapper stays
 * reusable.
 *
 * Spec 0061 §3.
 */
export async function deleteComment(
  client: HttpClient,
  commentId: number,
  opts: DeleteCommentOpts = {},
): Promise<DeleteCommentResult> {
  const raw = await client.request({
    method: 'DELETE',
    path: deleteCommentPath(commentId),
    schema: SuccessResponseSchema,
    ...(opts.signal !== undefined ? { signal: opts.signal } : {}),
    ...(opts.requestId !== undefined ? { requestId: opts.requestId } : {}),
  });
  return { raw };
}
