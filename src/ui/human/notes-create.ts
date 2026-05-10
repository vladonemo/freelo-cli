import { type NotesCreateData } from '../../api/schemas/note.js';

/**
 * Human-mode renderer for `freelo notes create` (R44, spec 0058).
 *
 * Live (with content):  `Created note "<name>" in project #<id> (#<note-id>, <N> bytes from <source>).`
 * Live (no content):    `Created note "<name>" in project #<id> (#<note-id>, name-only).`
 * Live (no name found): `Created note in project #<id> (#<note-id>, ...).`  // defensive
 * Dry-run (with content): `(dry-run) Would POST <path> (<N> bytes from <source>).`
 * Dry-run (no content):   `(dry-run) Would POST <path> (name-only).`
 */
export function renderNotesCreateHuman(data: NotesCreateData): string {
  if (data.would !== undefined) {
    if (data.source === null) {
      return `(dry-run) Would POST ${data.would.path} (name-only).`;
    }
    return `(dry-run) Would POST ${data.would.path} (${data.byte_length} bytes from ${data.source}).`;
  }

  const noteId = data.note?.id;
  const noteIdPart = noteId !== undefined ? `#${noteId}` : '#?';
  const name = data.note?.name ?? null;

  if (data.source === null) {
    if (name !== null && name !== undefined) {
      return `Created note ${JSON.stringify(name)} in project #${data.project_id} (${noteIdPart}, name-only).`;
    }
    return `Created note in project #${data.project_id} (${noteIdPart}, name-only).`;
  }

  if (name !== null && name !== undefined) {
    return `Created note ${JSON.stringify(name)} in project #${data.project_id} (${noteIdPart}, ${data.byte_length} bytes from ${data.source}).`;
  }
  return `Created note in project #${data.project_id} (${noteIdPart}, ${data.byte_length} bytes from ${data.source}).`;
}
