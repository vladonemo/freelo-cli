import { type TaskLabelsMergeData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels merge` (M06, spec 0068).
 *
 * Two shapes, gated on `data.would`:
 *   - Live success:    `Merged 3 labels into <to_uuid>.`
 *   - Dry-run (would): `(dry-run) Would merge 3 labels into <to_uuid>.`
 *
 * Both are followed by the same two-sentence caveat block, and it is not
 * decoration. `POST /task-labels/merge` returns `{ "result": "success" }` and
 * nothing else, so the headline "Merged 3 labels" is the *only* thing the CLI
 * can say — and on its own it reads as a completeness claim the API never
 * made. The two facts a reader needs in order not to be misled are:
 *
 *   1. The replacement reached only tasks in projects where the caller is a
 *      commander (yaml :2948). Tasks elsewhere silently kept the old label,
 *      and neither the CLI nor the API can say how many.
 *   2. The source label *definitions* still exist (yaml :2952). They are
 *      detached from every reachable task but remain in the account, and
 *      there is no `DELETE` endpoint for task labels anywhere in the contract
 *      (spec 0068 §2.2) — so this is permanent, not a missing follow-up step.
 *
 * The dry-run branch carries the caveats too: a preview whose only job is to
 * tell you what you are about to do should include the part you cannot undo.
 *
 * Sync (no `cli-table3`) — there is no tabular data here, just one line and a
 * note. Mirrors `files-delete.ts`.
 */
export function renderTaskLabelsMergeHuman(data: TaskLabelsMergeData): string {
  const noun = data.count === 1 ? 'label' : 'labels';
  const headline =
    data.would !== undefined
      ? `(dry-run) Would merge ${data.count} ${noun} into ${data.to_uuid}.`
      : `Merged ${data.count} ${noun} into ${data.to_uuid}.`;

  return [
    headline,
    '',
    'Scope: only tasks in projects where you are a commander are relabeled. Tasks in',
    'other projects keep the old label, and the API reports no per-task detail — so',
    'neither this command nor Freelo can tell you how many were skipped.',
    '',
    `The source label definitions still exist; only their task attachments moved.`,
    'Freelo exposes no endpoint to delete a task label, so they stay in your account.',
  ].join('\n');
}
