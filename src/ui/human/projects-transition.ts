import { type ProjectsTransitionData } from '../../api/schemas/project.js';

/**
 * Human renderer for `freelo projects archive` and `freelo projects activate`
 * (R30, spec 0043).
 *
 * Two shapes, gated on `data.would`:
 *   - Live success:    `Archived project #ID.` / `Activated project #ID.`
 *   - Dry-run (would): `(dry-run) Would archive project #ID.` /
 *                      `(dry-run) Would activate project #ID.`
 *
 * No `previous_state` — spec 0043 decision 1 skips the GET pre-check, so
 * the renderer cannot reference the prior state. Agents that need it call
 * `freelo projects show` first.
 *
 * Spec 0043 §3.6.
 */
export function renderProjectsTransitionHuman(data: ProjectsTransitionData): string {
  const verbInf = data.current_state === 'archived' ? 'archive' : 'activate';
  const verbPast = data.current_state === 'archived' ? 'Archived' : 'Activated';

  if (data.would !== undefined) {
    return `(dry-run) Would ${verbInf} project #${data.project_id}.`;
  }
  return `${verbPast} project #${data.project_id}.`;
}

/**
 * Render an error envelope for a single batch line/id in `human` mode.
 * Format: `Failed item N (id=ID): <message>`. `inputIndex` is 0-indexed; the
 * displayed number is 1-indexed for human eyes. Mirrors the equivalent
 * helper in `tasks-transition.ts`.
 */
export function renderProjectsBatchItemFailureHuman(
  inputIndex: number,
  projectId: number | null,
  message: string,
): string {
  const idPart = projectId === null ? '' : ` (id=${projectId})`;
  return `Failed item ${inputIndex + 1}${idPart}: ${message}`;
}
