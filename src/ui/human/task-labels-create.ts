import { type TaskLabelsCreateData } from '../../api/schemas/task-label.js';

/**
 * Human renderer for `freelo task-labels create` (R24, spec 0036 §3.3).
 *
 * Live:    `Created or matched 3 task labels: foo, bar, baz.`
 * Dry-run: `(dry-run) Would create or match 3 task labels: foo, bar, baz.`
 *
 * The server's fetch-or-create behavior means we cannot tell new from
 * reused; "Created or matched" is the honest copy.
 */
export function renderTaskLabelsCreateHuman(data: TaskLabelsCreateData): string {
  const names = data.labels.map((l) => l.name ?? '<unnamed>').join(', ');
  const noun = data.count === 1 ? 'task label' : 'task labels';
  if (data.would !== undefined) {
    return `(dry-run) Would create or match ${data.count} ${noun}: ${names}.`;
  }
  return `Created or matched ${data.count} ${noun}: ${names}.`;
}
