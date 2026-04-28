import { type CommentsEditData } from '../../api/schemas/comment.js';

/**
 * Human renderer for `freelo comments edit`.
 *
 * Two shapes (a third — batch row — is just the live shape repeated; the
 * batch loop calls this once per id):
 *
 *   - Live (single id or batch row):
 *       `Edited comment #<id> (<N> bytes from <source>).`
 *
 *   - Dry-run:
 *       `(dry-run) Would POST <path> (<N> bytes).`
 *
 * Sync — no I/O, no lazy imports needed.
 *
 * Spec 0029 §3.3.
 */
export function renderCommentsEditHuman(data: CommentsEditData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would POST ${data.would.path} (${data.byte_length} bytes).`;
  }
  const source = data.source ?? 'unknown';
  return `Edited comment #${data.comment_id} (${data.byte_length} bytes from ${source}).`;
}
