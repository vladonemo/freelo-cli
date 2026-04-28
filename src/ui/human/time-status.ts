/**
 * Human-mode renderer for `freelo time status` (R19, spec 0030).
 *
 * Discriminated on `data.active`:
 *
 *   - active: `Tracking <task #N "name"> for <Hh Mm Ss> (started <ISO>).`
 *     Falls back to `(no task)` when `task: null`. Note appended in quotes
 *     when present.
 *   - inactive: `No active timer.`
 */

import { type TimeStatusData } from '../../api/schemas/time.js';

export function renderTimeStatusHuman(data: TimeStatusData): string {
  if (data.active === false) {
    return 'No active timer.';
  }
  const s = data.session;
  const taskPart =
    s.task !== null
      ? `task #${s.task.id} "${truncate(s.task.name ?? '(unnamed)', 60)}"`
      : 'no task';
  const elapsed = formatElapsed(s.elapsed_seconds);
  const notePart = s.note !== null && s.note !== '' ? ` — "${truncate(s.note, 80)}"` : '';
  return `Tracking ${taskPart} for ${elapsed} (started ${s.started_at})${notePart}.`;
}

function formatElapsed(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max - 1)}…`;
}
