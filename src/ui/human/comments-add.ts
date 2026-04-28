import { type CommentsAddData } from '../../api/schemas/comment.js';

/**
 * Human renderer for `freelo comments add`.
 *
 * Three shapes:
 *
 *   - Live (regular comment):
 *       `Added comment to task #<id> (<N> bytes from <source>).`
 *
 *   - Live (auto-flip to description):
 *       `Added comment to task #<id> (<N> bytes from <source>). Note: this
 *        was the task's first comment, so it became the task description (use
 *        \`freelo tasks description set\` for explicit description writes).`
 *
 *   - Dry-run:
 *       `(dry-run) Would POST <path> (<N> bytes from <source>).`
 *
 * Sync — no I/O, no lazy imports needed.
 *
 * Spec 0028 §3.3.
 */
export function renderCommentsAddHuman(data: CommentsAddData): string {
  if (data.would !== undefined) {
    return `(dry-run) Would POST ${data.would.path} (${data.byte_length} bytes).`;
  }

  const source = data.source ?? 'unknown';
  const head = `Added comment to task #${data.task_id} (${data.byte_length} bytes from ${source}).`;

  if (data.is_description === true) {
    return (
      `${head} Note: this was the task's first comment, so it became the task ` +
      'description (use `freelo tasks description set` for explicit description writes).'
    );
  }
  return head;
}
