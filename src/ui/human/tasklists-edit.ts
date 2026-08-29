import { type TasklistsEditData } from '../../api/schemas/tasklist.js';

/**
 * Human renderer for `freelo tasklists edit` (M02, spec 0065).
 *
 * Three shapes:
 *   - Live success: `Updated tasklist #ID.` plus one indented line per
 *     applied change so the user can see what actually went over the wire.
 *   - Live partial success: the same, plus a prominent warning line when the
 *     priority reorder was requested and the server reported it did not
 *     apply. Exit code is still 0 (decision 4) — so this line is the only
 *     thing a human sees, and it must be impossible to miss in scrollback.
 *   - Dry-run: `(dry-run) Would update tasklist #ID.` plus the same change
 *     lines, and no priority claim (we did not make the call).
 *
 * The envelope's `notice` is NOT appended here — the caller owns that. This
 * renderer takes `data` only, matching `renderTasklistsCreateHuman`.
 */
export function renderTasklistsEditHuman(data: TasklistsEditData): string {
  const isDryRun = data.would !== undefined;
  const body = isDryRun ? data.would!.body : data.applied_changes;

  const lines: string[] = [
    isDryRun
      ? `(dry-run) Would update tasklist #${data.tasklist_id}.`
      : `Updated tasklist #${data.tasklist_id}.`,
  ];

  for (const line of describeChanges(body)) {
    lines.push(`  ${line}`);
  }

  // Partial-success warning. Only meaningful on a live call where the user
  // actually asked for a reorder.
  if (!isDryRun && data.priority_requested && !data.priority_applied) {
    lines.push(`  ! PRIORITY NOT APPLIED — every other field was saved, but the reorder failed.`);
    lines.push(
      `    Retry the reorder alone: freelo tasklists edit ${data.tasklist_id} --priority ${String(
        body.priority ?? '<n>',
      )}`,
    );
  }

  return lines.join('\n');
}

/**
 * One human line per field in the wire body, in a stable order. Clearing
 * values render as an explicit "cleared" rather than a bare `null`, because
 * `budget: null` is opaque to a reader who has not read the API docs.
 */
function describeChanges(body: TasklistsEditData['applied_changes']): string[] {
  const out: string[] = [];

  if (body.name !== undefined) out.push(`+ name: ${body.name}`);

  if (body.budget !== undefined) {
    out.push(
      body.budget === null
        ? '+ budget: cleared'
        : `+ budget: ${body.budget} (minor units, e.g. 100000 = 1000.00)`,
    );
  }

  if (body.time_budget_minutes !== undefined) {
    out.push(
      body.time_budget_minutes === null
        ? '+ time budget: cleared'
        : `+ time budget: ${body.time_budget_minutes} min`,
    );
  }

  if (body.worker_id !== undefined) {
    out.push(
      body.worker_id === null
        ? '+ default worker: cleared'
        : `+ default worker: #${body.worker_id}`,
    );
  }

  if (body.tracking_users_ids !== undefined) {
    out.push(
      body.tracking_users_ids.length === 0
        ? '+ followers: cleared (all removed)'
        : `+ followers: ${body.tracking_users_ids.map((id) => `#${id}`).join(', ')}`,
    );
  }

  if (body.should_change_existing_tasks === true) {
    out.push('+ follower change propagated to EVERY existing task in the tasklist');
  }

  if (body.priority !== undefined) {
    out.push(`+ position in project: ${body.priority} (ordering, not importance)`);
  }

  return out;
}
