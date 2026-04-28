/**
 * Human-mode renderer for `freelo time edit` (R20, spec 0032).
 *
 * Live:
 *   `Edited active timer (uuid <uuid>): <changes summary>`
 *
 * Dry-run:
 *   `[dry-run] Would edit active timer: <changes summary>`
 *
 * Changes summary: comma-separated `key=value` pairs derived from
 * `applied_changes`. `task_id: null` renders as `task=null` (so users see
 * the disassociation explicitly). Empty notes render as `note=""`.
 */

import { type TimeEditLiveData, type TimeEditDryRunData } from '../../api/schemas/time.js';

type RenderableData = TimeEditLiveData | TimeEditDryRunData;

export function renderTimeEditHuman(data: RenderableData): string {
  const summary = formatChanges(data.applied_changes);
  if (!('uuid' in data)) {
    return `[dry-run] Would edit active timer: ${summary}.`;
  }
  return `Edited active timer (uuid ${data.uuid}): ${summary}.`;
}

function formatChanges(changes: TimeEditLiveData['applied_changes']): string {
  const parts: string[] = [];
  if ('task_id' in changes) {
    parts.push(`task=${changes.task_id === null ? 'null' : String(changes.task_id)}`);
  }
  if ('note' in changes) {
    parts.push(`note=${JSON.stringify(changes.note)}`);
  }
  return parts.length === 0 ? '(no changes)' : parts.join(', ');
}
