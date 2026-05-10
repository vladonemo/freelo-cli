import { type NotesEditData } from '../../api/schemas/note.js';

/**
 * Human-mode renderer for `freelo notes edit` (R44, spec 0058).
 *
 * Live:    `Edited note #<id> (<changes-summary>).`
 * Dry-run: `(dry-run) Would POST <path> (<changes-summary>).`
 *
 * `changes-summary`:
 *   - `name="<new>"` if --name was set
 *   - `<N> bytes from <source>` if content was set
 *   - joined by ", " when both
 */
export function renderNotesEditHuman(data: NotesEditData): string {
  const summary = formatChanges(data);
  if (data.would !== undefined) {
    return `(dry-run) Would POST ${data.would.path} (${summary}).`;
  }
  return `Edited note #${data.note_id} (${summary}).`;
}

function formatChanges(data: NotesEditData): string {
  const parts: string[] = [];
  if (data.applied_changes.name !== undefined) {
    parts.push(`name=${JSON.stringify(data.applied_changes.name)}`);
  }
  if (data.source !== null) {
    parts.push(`${data.byte_length} bytes from ${data.source}`);
  }
  return parts.length > 0 ? parts.join(', ') : '(no changes)';
}
