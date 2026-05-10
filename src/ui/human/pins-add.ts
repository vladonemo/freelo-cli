import { type PinsAddData } from '../../api/schemas/pin.js';

/**
 * Human-mode renderer for `freelo pins add` (R44, spec 0058).
 *
 * Live:    `Pinned <link> to project #<id> (#<pin-id><, title=...>).`
 * Dry-run: `(dry-run) Would POST <path> (link=<url><, title=...>).`
 */
export function renderPinsAddHuman(data: PinsAddData): string {
  if (data.would !== undefined) {
    const titlePart =
      data.applied_title !== undefined ? `, title=${JSON.stringify(data.applied_title)}` : '';
    return `(dry-run) Would POST ${data.would.path} (link=${JSON.stringify(data.applied_link)}${titlePart}).`;
  }
  const pinId = data.pin?.id;
  const idPart = pinId !== undefined ? `#${pinId}` : '#?';
  const titlePart =
    data.applied_title !== undefined ? `, title=${JSON.stringify(data.applied_title)}` : '';
  return `Pinned ${JSON.stringify(data.applied_link)} to project #${data.project_id} (${idPart}${titlePart}).`;
}
